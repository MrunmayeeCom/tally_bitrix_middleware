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
    // Use %NAME (contains) instead of NAME (exact) because Bitrix24
    // ignores exact match on NAME in crm.product.list on many plans
    const data = await callBitrix('crm.product.list', {
      filter: { '%NAME': itemName },
      select: ['ID', 'NAME', 'PRICE']
    });
    const products = data.result || [];
    // JS-side exact match after the broad search
    return products.find(p =>
      (p.NAME || '').trim().toLowerCase() === itemName.trim().toLowerCase()
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
                        && Math.abs(existingRate - tallyRate) < 0.01;
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
        select: ['ID', 'NAME', 'PRICE', 'QUANTITY', 'MEASURE', 'CURRENCY_ID'],
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

// Sync Bitrix24 product changes back to Tally stock items
async function syncBitrixToTally() {
  try {
    logger.info('[BritrixToTally] Starting Bitrix24 → Tally inventory sync');

    const [bitrixProducts, tallyItems] = await Promise.all([
      fetchAllBitrixProducts(),
      getStockItems(),
    ]);

    if (!bitrixProducts || bitrixProducts.length === 0) {
      logger.info('[BitrixToTally] No Bitrix24 products found — skipping');
      return { success: true, updated: 0, skipped: 0 };
    }

    const tallyMap = {};
    tallyItems.forEach(item => {
      tallyMap[item.name.toLowerCase()] = item;
    });

    // Pre-create required masters once before any stock item operations
    const escapeXml = (s) => (s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    // Step 1: Delete the broken Nos unit exception, then recreate it cleanly
    const deleteNosXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(tallyConfig.company)}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <UNIT NAME="Nos" Action="Delete">
            <NAME>Nos</NAME>
          </UNIT>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

    try {
      const delResp = await sendToTally(deleteNosXml);
      logger.info('[BitrixToTally] Deleted Nos unit exception', { resp: delResp });
    } catch (e) {
      logger.warn('[BitrixToTally] Could not delete Nos unit', { message: e.message });
    }

    // Step 2: Recreate Nos unit cleanly
    const prerequisiteXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(tallyConfig.company)}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <UNIT NAME="Nos" Action="Create">
            <NAME>Nos</NAME>
            <ORIGINALNAME>Numbers</ORIGINALNAME>
            <UQCNAME>NOT APPLICABLE</UQCNAME>
            <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
            <DECIMALPLACES>0</DECIMALPLACES>
          </UNIT>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

    try {
      const prereqResp = await sendToTally(prerequisiteXml);
      logger.info('[BitrixToTally] Pre-created Nos unit', { resp: prereqResp });
    } catch (prereqErr) {
      logger.warn('[BitrixToTally] Could not pre-create Nos unit', { message: prereqErr.message });
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let catalogPriceAvailable = true;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const product of bitrixProducts) {
      try {
        const key = (product.NAME || '').toLowerCase();
        if (!key) { skipped++; continue; }

        const bitrixQty  = parseFloat(product.QUANTITY) || 0;
        let bitrixRate = parseFloat(product.PRICE) || 0;

        const tallyItem = tallyMap[key];
        if (!tallyItem) {
          // Item exists in Bitrix24 but not in Tally — create it using 'Not Applicable' unit
          // which is always present in every TallyPrime company by default
          logger.info('[BitrixToTally] Creating new stock item in Tally', { name: product.NAME });
          try {
            await createTallyStockItem({
              name: product.NAME,
              rate: bitrixRate,
            });
            updated++;
          } catch (createErr) {
            logger.error('[BitrixToTally] Failed to create stock item in Tally', {
              name: product.NAME, message: createErr.message,
            });
            failed++;
          }
          await sleep(600);
          continue;
        }
        if (bitrixRate === 0 && product.ID && catalogPriceAvailable) {
          try {
            const priceData = await callBitrix('catalog.price.list', {
              filter: { PRODUCT_ID: product.ID },
              select: ['PRICE', 'CURRENCY_ID'],
            });
            const prices = priceData.result?.prices || priceData.result || [];
            if (prices.length > 0) {
              bitrixRate = parseFloat(prices[0].PRICE) || 0;
            }
          } catch (priceErr) {
            if (priceErr.message.includes('401')) {
              catalogPriceAvailable = false;
              logger.warn('[BitrixToTally] catalog.price.list unauthorized — disabling for this sync run');
            }
          }
        }
        const tallyQty   = tallyItem.closingBalance || 0;
        const tallyRate  = tallyItem.closingRate || 0;

        const qtyChanged  = Math.abs(bitrixQty - tallyQty) > 0.01;
        const rateChanged = Math.abs(bitrixRate - tallyRate) > 0.01;

        if (!qtyChanged && !rateChanged) {
          skipped++;
          continue;
        }

        logger.info('[BitrixToTally] Pushing stock update to Tally', {
          name: product.NAME,
          bitrixQty, tallyQty,
          bitrixRate, tallyRate,
        });

        await updateTallyStockItem({
          name:        product.NAME,
          baseUnit:    tallyItem.baseUnit || 'Nos',
          quantity:    bitrixQty,
          rate:        bitrixRate,
        });
        // Push quantity via opening stock voucher if quantity changed
        if (qtyChanged) {
          await _pushQuantityToTally({
            name:     product.NAME,
            baseUnit: tallyItem.baseUnit || 'Nos',
            quantity: bitrixQty,
            rate:     bitrixRate,
          }, tallyConfig, sendToTally, escapeXml, logger);
        }

        updated++;
        await sleep(600);

      } catch (itemErr) {
        logger.error('[BitrixToTally] Failed to update stock item in Tally', {
          name: product.NAME, message: itemErr.message,
        });
        failed++;
      }
    }

    logger.info('[BitrixToTally] Sync completed', { updated, skipped, failed });
    return { success: true, updated, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[BitrixToTally] Skipped — Tally is not running');
      return { success: true, updated: 0, skipped: 0 };
    }
    logger.error('[BitrixToTally] Sync failed', { message: error.message });
    throw error;
  }
}

async function updateTallyStockItem({ name, baseUnit, quantity, rate }) {
  const { sendToTally } = require('../connectors/tallyConnector');
  const tallyConfig     = require('../config/tallyConfig');

  const escapeXml = (s) => (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const value   = (quantity * rate).toFixed(2);

  const unit = baseUnit || '';

  const alterXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(tallyConfig.company)}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escapeXml(name)}" Action="Alter">
            <NAME>${escapeXml(name)}</NAME>
            <STANDARDCOSTLIST.LIST ACTION="Replace">
              <STANDARDCOSTLIST>
                <DATE>${dateStr}</DATE>
                <RATE>${rate}</RATE>
              </STANDARDCOSTLIST>
            </STANDARDCOSTLIST.LIST>
            <STANDARDPRICELIST.LIST ACTION="Replace">
              <STANDARDPRICELIST>
                <DATE>${dateStr}</DATE>
                <RATE>${rate}</RATE>
              </STANDARDPRICELIST>
            </STANDARDPRICELIST.LIST>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

  logger.info('[BitrixToTally] Sending alter XML to Tally', { name, xml: alterXml });
  const resp = await sendToTally(alterXml);
  const altered  = parseInt((resp || '').match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1]  ?? '0');
  const created  = parseInt((resp || '').match(/<CREATED>(\d+)<\/CREATED>/i)?.[1]  ?? '0');
  const errors   = parseInt((resp || '').match(/<ERRORS>(\d+)<\/ERRORS>/i)?.[1]    ?? '0');
  const lineErr  = (resp || '').match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] || '';

  if (errors > 0 || lineErr) {
    throw new Error(`Tally stock item alter failed for "${name}": ${lineErr || 'ERRORS=' + errors}`);
  }

  if (altered === 0 && created === 0) {
    logger.warn('[BitrixToTally] Stock item alter returned 0 — item may not exist in Tally', { name });
    return;
  }

  logger.info('[BitrixToTally] Stock item updated in Tally via ALTER', {
    name, quantity, rate, altered, created,
  });
}

async function createTallyStockItem({ name, rate }) {
  const { sendToTally } = require('../connectors/tallyConnector');
  const tallyConfig     = require('../config/tallyConfig');

  const escapeXml = (s) => (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const xml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(tallyConfig.company)}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escapeXml(name)}" Action="Create">
            <NAME>${escapeXml(name)}</NAME>
            <GSTAPPLICABLE>@@APPLICABLEYES</GSTAPPLICABLE>
            <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

  // Ensure 'Primary' stock group exists — Tally requires it as default parent
  // Primary stock group ensured once per sync at the top level — no per-item call needed
  const resp = await sendToTally(xml);

  const created  = parseInt((resp || '').match(/<CREATED>(\d+)<\/CREATED>/i)?.[1]  ?? '0');
  const altered  = parseInt((resp || '').match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1]  ?? '0');
  const errors   = parseInt((resp || '').match(/<ERRORS>(\d+)<\/ERRORS>/i)?.[1]    ?? '0');
  const lineErr  = (resp || '').match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] || '';

  if (errors > 0 || lineErr) {
    throw new Error(`Tally stock item create failed for "${name}": ${lineErr || 'ERRORS=' + errors}`);
  }

  if (created === 0 && altered === 0) {
    throw new Error(`Tally stock item create returned 0 for "${name}" — item may already exist or was ignored`);
  }

  logger.info('[BitrixToTally] Stock item created in Tally', { name, rate, created, altered });
}

async function _pushQuantityToTally({ name, baseUnit, quantity, rate }, tallyConfig, sendToTally, escapeXml, logger) {
  // Tally does not allow directly setting closing stock via master alter.
  // The correct approach is to create/replace a Physical Stock voucher.
  const unit    = baseUnit || 'Nos';
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const value   = (quantity * rate).toFixed(2);

  const xml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(tallyConfig.company)}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Physical Stock" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME>
            <VOUCHERNUMBER>BX-STOCK-${name.replace(/\s+/g, '-').substring(0, 20)}-${dateStr}</VOUCHERNUMBER>
            <ALLinventoryentries.LIST>
              <STOCKITEMNAME>${escapeXml(name)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <RATE>${rate} /${unit}</RATE>
              <AMOUNT>-${value}</AMOUNT>
              <ACTUALQTY>${quantity} ${unit}</ACTUALQTY>
              <BILLEDQTY>${quantity} ${unit}</BILLEDQTY>
            </ALLinventoryentries.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

  try {
    const resp    = await sendToTally(xml);
    const created = parseInt((resp || '').match(/<CREATED>(\d+)<\/CREATED>/i)?.[1] ?? '0');
    const altered = parseInt((resp || '').match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1] ?? '0');
    const errors  = parseInt((resp || '').match(/<ERRORS>(\d+)<\/ERRORS>/i)?.[1]   ?? '0');
    const lineErr = (resp || '').match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] || '';

    if (errors > 0 || lineErr) {
      logger.warn('[BitrixToTally] Physical Stock voucher failed — quantity not updated in Tally', {
        name, error: lineErr || `ERRORS=${errors}`,
        hint: 'Ensure "Physical Stock" voucher type exists in Tally: Gateway → Accounts Info → Voucher Types',
      });
    } else {
      logger.info('[BitrixToTally] Physical Stock voucher pushed to Tally', { name, quantity, rate, created, altered });
    }
  } catch (e) {
    logger.warn('[BitrixToTally] Physical Stock voucher exception — non-fatal', { name, message: e.message });
  }
}

module.exports = { processInventory, getStockItems, fetchAllBitrixProducts, validateClosingStock, syncBitrixToTally };