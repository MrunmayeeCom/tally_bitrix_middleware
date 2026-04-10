/**
 * itemInvoiceBuilder.js
 * Reads Tally sales vouchers WITH product line items (ALLINVENTORYENTRIES)
 * and creates Bitrix24 Smart Invoices with proper product rows attached.
 *
 * Separate from tallyInvoiceProcessor.js which only syncs the total amount.
 */

const { sendToTally }          = require('../connectors/tallyConnector');
const { callBitrix }           = require('../connectors/bitrixConnector');
const { fetchAllBitrixProducts } = require('./inventoryProcessor');
const tallyConfig              = require('../config/tallyConfig');
const logger                   = require('../utils/logger');
const fs                       = require('fs');
const path                     = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/item-invoice-cache.json');

// ── cache helpers ─────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveCache(data) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[ItemInvoice] Cache save failed: ' + e.message);
  }
}

// ── Tally fetch ───────────────────────────────────────────────────────────────

async function getSalesVouchersWithItems() {
  logger.info('[ItemInvoice] Fetching sales vouchers with line items from Tally');

  const today    = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const xml = `
    <ENVELOPE>
      <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>Day Book</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
              <SVTODATE>${fmt(today)}</SVTODATE>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>`.trim();

  const response = await sendToTally(xml);
  return parseSalesVouchersWithItems(response);
}

// ── XML parser — captures ALLINVENTORYENTRIES line items ──────────────────────

function parseSalesVouchersWithItems(xml) {
  const vouchers = [];
  const voucherRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
  let match;

  while ((match = voucherRegex.exec(xml)) !== null) {
    const block = match[2];

    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(block);
      return m ? m[1].trim() : '';
    };

    // Only process Sales type vouchers
    const voucherType = get('VOUCHERTYPENAME') || '';
    const isSales = ['sales', 'tax invoice', 'tax inv']
      .some(t => voucherType.toLowerCase().includes(t));
    if (!isSales) continue;

    // Skip vouchers already created by Bitrix24 sync (BX- prefix)
    const voucherNumber = get('VOUCHERNUMBER') || '';
    if (voucherNumber.startsWith('BX-')) continue;

    const partyName = get('PARTYLEDGERNAME') || '';
    const dateRaw   = get('DATE') || '';
    const narration = get('NARRATION') || '';
    const amount    = Math.abs(parseFloat(get('AMOUNT')) || 0);

    if (!partyName || amount === 0) continue;

    // ── Parse inventory line items ────────────────────────────────────────────
    // Tally stores each product row inside ALLINVENTORYENTRIES.LIST blocks
    const items = [];
    const itemRegex = /<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(block)) !== null) {
      const itemBlock = itemMatch[1];

      const getI = (tag) => {
        const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(itemBlock);
        return m ? m[1].trim() : '';
      };

      const stockItemName = getI('STOCKITEMNAME') || '';
      if (!stockItemName) continue;

      // ACTUALQTY comes as "5 Nos" or "5.00 Nos" — extract number and unit separately
      const qtyRaw  = getI('ACTUALQTY') || '0';
      const qtyNum  = Math.abs(parseFloat(qtyRaw) || 0);
      const qtyUnit = (qtyRaw.match(/[a-zA-Z]+/) || [''])[0].trim();

      // RATE comes as "10.00/Nos" — extract number only
      const rateRaw = getI('RATE') || '0';
      const rate    = Math.abs(parseFloat(rateRaw) || 0);

      const itemAmount = Math.abs(parseFloat(getI('AMOUNT')) || 0);

      if (qtyNum > 0) {
        items.push({
          stockItemName,
          qty:    qtyNum,
          rate,
          amount: itemAmount,
          unit:   qtyUnit,
        });
      }
    }

    const date = dateRaw.length === 8
      ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
      : dateRaw;

    vouchers.push({
      voucherNumber,
      partyName,
      date,
      amount,
      voucherType,
      narration,
      items,
    });
  }

  logger.info(`[ItemInvoice] Parsed ${vouchers.length} sales vouchers — ` +
    `${vouchers.filter(v => v.items.length > 0).length} have line items`);
  return vouchers;
}

// ── Bitrix24 helpers ──────────────────────────────────────────────────────────

// Find existing contact or company in Bitrix24 by party name
async function findBitrixParty(partyName) {
  try {
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE'],
    });
    const company = (companyData.result || []).find(
      c => (c.TITLE || '').toLowerCase() === partyName.toLowerCase()
    );
    if (company) return { companyId: company.ID };

    const contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME'],
    });
    const contact = (contactData.result || []).find(
      c => `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim().toLowerCase() === partyName.toLowerCase()
    );
    if (contact) return { contactId: contact.ID };
  } catch (e) {
    logger.warn('[ItemInvoice] Party lookup failed', { partyName, message: e.message });
  }
  return {};
}

// Build Bitrix24 product rows from Tally line items
// Matches each Tally stock item name against the Bitrix24 product catalog
function buildProductRows(tallyItems, bitrixProducts) {
  // Build a lookup map: lowercase name → Bitrix24 product
  const productMap = {};
  bitrixProducts.forEach(p => {
    productMap[(p.NAME || '').toLowerCase()] = p;
  });

  const rows = [];

  for (const item of tallyItems) {
    const key            = item.stockItemName.toLowerCase();
    const bitrixProduct  = productMap[key];

    // Use Tally rate as the price — most accurate source
    // Fall back to Bitrix24 catalog price if Tally rate is 0
    const price = item.rate > 0
      ? item.rate
      : bitrixProduct ? (parseFloat(bitrixProduct.PRICE) || 0) : 0;

    const row = {
      PRODUCT_NAME: item.stockItemName,
      PRICE:        price,
      QUANTITY:     item.qty,
      DISCOUNT:     0,
      CURRENCY_ID:  'INR',
    };

    // Link to existing Bitrix24 product if found in catalog
    // This connects the invoice row to the inventory item
    if (bitrixProduct) {
      row.PRODUCT_ID = bitrixProduct.ID;
      logger.info('[ItemInvoice] Matched line item to Bitrix24 product', {
        name:      item.stockItemName,
        productId: bitrixProduct.ID,
        price,
      });
    } else {
      // Product not in catalog yet — will create as a standalone row
      logger.warn('[ItemInvoice] Line item not found in Bitrix24 catalog — adding as standalone row', {
        name: item.stockItemName,
      });
    }

    rows.push(row);
  }

  return rows;
}

// ── Main processor ────────────────────────────────────────────────────────────

async function processItemInvoices() {
  try {
    logger.info('[ItemInvoice] Starting item-based invoice sync');

    // Feature gate check
    const featureGate = (() => {
      try { return require('../services/featureGate'); } catch { return null; }
    })();
    if (featureGate && !featureGate.isEnabled('invoice-sync')) {
      logger.info('[ItemInvoice] invoice-sync not enabled on plan — skipping');
      return { success: true, created: 0, skipped: 0 };
    }

    // Fetch Tally vouchers with line items + Bitrix24 product catalog in parallel
    const [vouchers, bitrixProducts] = await Promise.all([
      getSalesVouchersWithItems(),
      fetchAllBitrixProducts(),
    ]);

    logger.info(`[ItemInvoice] ${vouchers.length} vouchers from Tally | ` +
      `${bitrixProducts.length} products in Bitrix24 catalog`);

    const cache    = loadCache();
    const newCache = { ...cache };
    let created = 0, skipped = 0, failed = 0, noItems = 0;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const voucher of vouchers) {
      try {
        // Skip if already synced (same voucher number + amount)
        const cacheKey = `item_${voucher.voucherNumber}_${voucher.amount}`;
        if (cache[cacheKey]) {
          skipped++;
          continue;
        }

        // Skip vouchers with no inventory line items
        // These are service invoices or amount-only entries — handled by tallyInvoiceProcessor
        if (!voucher.items || voucher.items.length === 0) {
          logger.info('[ItemInvoice] No inventory line items — skipping (handled by amount-only sync)', {
            voucherNumber: voucher.voucherNumber,
          });
          noItems++;
          continue;
        }

        // Find the party in Bitrix24
        const partyIds = await findBitrixParty(voucher.partyName);
        await sleep(300); // avoid rate limiting

        // Build product rows from Tally line items
        const productRows = buildProductRows(voucher.items, bitrixProducts);

        // Step 1 — Create the Smart Invoice in Bitrix24
        const invoiceFields = {
          title:       `${voucher.partyName} - ${voucher.voucherNumber}`,
          opportunity: voucher.amount,
          currencyId:  'INR',
          createdTime: voucher.date,
          closeDate:   voucher.date,
          ...partyIds,
          // Custom fields to track Tally origin
          UF_TALLY_VOUCHER_NO: voucher.voucherNumber,
          UF_TALLY_SYNCED:     'Y',
          UF_INVOICE_NUMBER:   voucher.voucherNumber,
          UF_INVOICE_DATE:     voucher.date,
        };

        const invoiceData = await callBitrix('crm.item.add', {
          entityTypeId: 31, // Smart Invoice
          fields:       invoiceFields,
        });

        const invoiceId = invoiceData.result?.item?.id || invoiceData.result;

        if (!invoiceId) {
          logger.error('[ItemInvoice] Invoice creation returned no ID', {
            voucherNumber: voucher.voucherNumber,
          });
          failed++;
          continue;
        }

        // Step 2 — Attach product rows to the invoice
        if (productRows.length > 0) {
          await callBitrix('crm.item.productrow.set', {
            ownerType:   'SI',  // SI = Smart Invoice
            ownerId:     invoiceId,
            productRows,
          });
          logger.info('[ItemInvoice] Product rows attached to invoice', {
            invoiceId,
            rows:      productRows.length,
            products:  productRows.map(r => `${r.PRODUCT_NAME} × ${r.QUANTITY}`).join(', '),
          });
        }

        // Save to cache so we don't recreate on next run
        newCache[cacheKey] = {
          invoiceId,
          syncedAt:  new Date().toISOString(),
          itemCount: productRows.length,
        };

        logger.info('[ItemInvoice] Item-based invoice created successfully', {
          voucherNumber: voucher.voucherNumber,
          partyName:     voucher.partyName,
          amount:        voucher.amount,
          lineItems:     productRows.length,
          invoiceId,
        });

        created++;
        await sleep(500); // rate limiting between invoices

      } catch (e) {
        logger.error('[ItemInvoice] Failed to create item invoice', {
          voucherNumber: voucher.voucherNumber,
          partyName:     voucher.partyName,
          message:       e.message,
        });
        failed++;
      }
    }

    // Only save cache if something was created
    if (created > 0) saveCache(newCache);

    logger.info('[ItemInvoice] Sync complete', { created, skipped, noItems, failed });
    return { success: true, created, skipped, noItems, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[ItemInvoice] Skipped — Tally is not running');
      return { success: true, created: 0, skipped: 0, noItems: 0 };
    }
    logger.error('[ItemInvoice] Sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processItemInvoices, getSalesVouchersWithItems, buildProductRows };