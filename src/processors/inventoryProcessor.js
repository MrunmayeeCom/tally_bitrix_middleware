const { sendToTally } = require('../connectors/tallyConnector');
const { callBitrix } = require('../connectors/bitrixConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

// Parse Tally stock items XML response
function parseStockItemsXml(xml) {
  try {
    const items = [];
    const regex = /<STOCKITEM\b[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
    let match;

    while ((match = regex.exec(xml)) !== null) {
      const block = match[1];
      
      const get = (tag) => {
        const m = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      const nameAttr = /NAME="([^"]+)"/i.exec(match[0]);
      const name = get('NAME') || (nameAttr ? nameAttr[1].trim() : '');
      
      if (!name) continue;

      // Tally returns quantities as "39 Mth" or "-12 Mth" — extract number only
      const parseQty = (raw) => {
        if (!raw) return 0;
        const num = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
        return num ? Math.abs(parseFloat(num[0])) : 0;
      };

      // Tally returns rates with commas like "1,46,114.50" — strip commas first
      const parseRate = (raw) => {
        if (!raw) return 0;
        return parseFloat(raw.replace(/,/g, '')) || 0;
      };

      items.push({
        name,
        baseUnit:       get('BASEUNITS')      || '',
        closingBalance: parseQty(get('CLOSINGBALANCE')),
        closingRate:    parseRate(get('CLOSINGRATE')),
        closingValue:   parseRate(get('CLOSINGVALUE')),
        parent:         get('PARENT')         || '',
      });
    }

    return items;
  } catch (err) {
    logger.error('Failed to parse stock items XML', { message: err.message });
    return [];
  }
}

// Fetch stock items from Tally
async function getStockItems() {
  logger.info('Fetching stock items from Tally');
  // DEBUG — log raw XML to see exact tag format (remove after testing)
  const debugXml = await (async () => {
    try {
      const { sendToTally } = require('../connectors/tallyConnector');
      const testXml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><AccountType>Stock Items</AccountType></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
      const raw = await sendToTally(testXml);
      // Log first stock item block only
      const firstItem = raw.match(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/i);
      if (firstItem) logger.info('[InventoryDebug] First STOCKITEM block:', firstItem[0].substring(0, 800));
      else {
        logger.warn('[InventoryDebug] No STOCKITEM tag found in response');
        logger.warn('[InventoryDebug] Raw response first 1000 chars:', raw.substring(0, 1000));
      }
    } catch(e) { logger.warn('[InventoryDebug] Debug failed:', e.message); }
  })();

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>List of Accounts</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              <AccountType>Stock Items</AccountType>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  const items = parseStockItemsXml(response);
  logger.info(`Fetched ${items.length} stock items from Tally`);
  return items;
}

// Find existing product in Bitrix24 by name
async function findBitrixProduct(itemName) {
  try {
    const data = await callBitrix('crm.product.list', {
      filter: { NAME: itemName },
      select: ['ID', 'NAME', 'PRICE']
    });
    const products = data.result || [];
    return products.find(p => 
      (p.NAME || '').toLowerCase() === itemName.toLowerCase()
    ) || null;
  } catch (e) {
    logger.warn('Product search failed', { itemName, message: e.message });
    return null;
  }
}

// Create product in Bitrix24
async function createBitrixProduct(item) {
  const fields = {
    NAME: item.name,
    PRICE: item.closingRate || 0,
    CURRENCY_ID: 'INR',
    MEASURE: getMeasureCode(item.baseUnit),
    QUANTITY: item.closingBalance || 0,
  };

  const data = await callBitrix('crm.product.add', { fields });
  return data.result;
}

// Update existing product in Bitrix24
async function updateBitrixProduct(productId, item) {
  const fields = {
    PRICE: item.closingRate || 0,
    QUANTITY: item.closingBalance || 0,
  };

  await callBitrix('crm.product.update', {
    id: productId,
    fields
  });
}

// Map Tally unit to Bitrix24 measure code
function getMeasureCode(tallyUnit) {
  const map = {
    'nos': 796,  // Pieces
    'pcs': 796,
    'kg': 163,   // Kilogram
    'ltr': 112,  // Liter
    'mtr': 6,    // Meter
    'box': 778,  // Box
  };
  return map[tallyUnit.toLowerCase()] || 796; // default to Pieces
}

// Main inventory sync processor
async function processInventory() {
  try {
    logger.info('Inventory sync started');

    // Step 1: Fetch stock items from Tally
    const stockItems = await getStockItems();

    if (!stockItems || stockItems.length === 0) {
      logger.info('No stock items found in Tally');
      return { success: true, created: 0, updated: 0, skipped: 0, discrepancies: [] };
    }

    // Step 1b: Fetch existing Bitrix24 products for validation
    const existingProducts = await fetchAllBitrixProducts();
    const discrepancies = validateClosingStock(stockItems, existingProducts);
    
    if (discrepancies.length > 0) {
      logger.warn(`Found ${discrepancies.length} stock discrepancies`, { discrepancies });
    }

    logger.info(`Processing ${stockItems.length} stock items`);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Step 2: Sync each item to Bitrix24
    for (const item of stockItems) {
      try {
        // Check if product already exists
        const existingProduct = await findBitrixProduct(item.name);

        if (existingProduct) {
          const existingQty  = parseFloat(existingProduct.QUANTITY) || 0;
          const existingRate = parseFloat(existingProduct.PRICE)    || 0;
          const tallyQty     = item.closingBalance || 0;
          const tallyRate    = item.closingRate    || 0;
          const noChange = Math.abs(existingQty - tallyQty) < 0.01
                        && Math.abs(existingRate - tallyRate) < 0.01
                        && !(tallyQty === 0 && tallyRate === 0 && existingQty === 0 && existingRate === 0 && !existingProduct.NAME);
          if (noChange) { skipped++; continue; }
          await updateBitrixProduct(existingProduct.ID, item);
          logger.info('Product updated in Bitrix24', {
            name: item.name,
            productId: existingProduct.ID,
            quantity: item.closingBalance,
            rate: item.closingRate
          });
          updated++;
        } else {
          // Skip creating items with no name only
          if (!item.name) {
            skipped++;
            continue;
          }
          const newId = await createBitrixProduct(item);
          logger.info('Product created in Bitrix24', {
            name: item.name,
            productId: newId,
            quantity: item.closingBalance,
            rate: item.closingRate
          });
          created++;
        }

        await sleep(500); // Rate limiting

      } catch (itemError) {
        logger.error('Failed to sync stock item', {
          name: item.name,
          message: itemError.message
        });
        failed++;
      }
    }

    logger.info('Inventory sync completed', { created, updated, skipped, failed });
    return { success: true, created, updated, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('Inventory sync skipped — Tally is not running');
      return { success: true, created: 0, updated: 0, skipped: 0 };
    }
    logger.error('Inventory sync failed', { message: error.message });
    throw error;
  }
}

// Fetch all existing products from Bitrix24
async function fetchAllBitrixProducts() {
  try {
    const allProducts = [];
    let start = 0;
    
    while (true) {
      const data = await callBitrix('crm.product.list', {
        select: ['ID', 'NAME', 'PRICE', 'QUANTITY'],
        start
      });
      const products = data.result || [];
      allProducts.push(...products);
      
      if (!data.next || products.length === 0) break;
      start = data.next;
    }
    
    logger.info(`Fetched ${allProducts.length} products from Bitrix24`);
    return allProducts;
  } catch (e) {
    logger.warn('Failed to fetch Bitrix24 products', { message: e.message });
    return [];
  }
}

// Validate closing stock between Tally and Bitrix24
function validateClosingStock(tallyItems, bitrixProducts) {
  const discrepancies = [];
  
  for (const tallyItem of tallyItems) {
    const bitrixProduct = bitrixProducts.find(p => 
      (p.NAME || '').toLowerCase() === tallyItem.name.toLowerCase()
    );
    
    if (bitrixProduct) {
      const tallyQty = tallyItem.closingBalance || 0;
      const bitrixQty = parseFloat(bitrixProduct.QUANTITY) || 0;
      const tallyRate = tallyItem.closingRate || 0;
      const bitrixRate = parseFloat(bitrixProduct.PRICE) || 0;
      
      if (Math.abs(tallyQty - bitrixQty) > 0.01 || Math.abs(tallyRate - bitrixRate) > 0.01) {
        discrepancies.push({
          name: tallyItem.name,
          tallyQty,
          bitrixQty,
          qtyDiff: tallyQty - bitrixQty,
          tallyRate,
          bitrixRate,
          rateDiff: tallyRate - bitrixRate,
          productId: bitrixProduct.ID
        });
      }
    }
  }
  
  return discrepancies;
}

module.exports = { processInventory, getStockItems, fetchAllBitrixProducts, validateClosingStock };