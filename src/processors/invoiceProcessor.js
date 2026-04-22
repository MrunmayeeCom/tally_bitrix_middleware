const { getInvoice } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const tallyConfig = require('../config/tallyConfig');

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const INVOICE_DEDUP_PATH = path.join(__dirname, '../../logs/invoice-dedup-cache.json');

function loadInvoiceDedup() {
  try {
    if (fs.existsSync(INVOICE_DEDUP_PATH)) {
      const data = JSON.parse(fs.readFileSync(INVOICE_DEDUP_PATH, 'utf8'));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return Object.fromEntries(
        Object.entries(data).filter(([, ts]) => ts > cutoff)
      );
    }
  } catch {}
  return {};
}

function saveInvoiceDedup(data) {
  try {
    const dir = path.dirname(INVOICE_DEDUP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INVOICE_DEDUP_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

let _invoiceDedupCache = loadInvoiceDedup();

async function processInvoice(entityId, isUpdate = false, invoiceType = 'smart') {
  try {
    logger.info(`Processing invoice — ${isUpdate ? 'UPDATE' : 'CREATE'} — type: ${invoiceType}`, { entityId });

    // Step 1: Fetch real invoice data from Bitrix24
    const invoice = await getInvoice(entityId, invoiceType);
    if (!invoice) throw new Error(`Invoice not found: ${entityId}`);

    // Step 1b: Ensure the party ledger exists in Tally before pushing the voucher
    const partyName = invoice.clientTitle || invoice.CLIENT_TITLE || '';
    logger.info('Party name being used for invoice', { 
      entityId, 
      partyName, 
      clientTitle: invoice.clientTitle, 
      CLIENT_TITLE: invoice.CLIENT_TITLE,
      companyId: invoice.companyId 
    });
    if (!partyName) {
      logger.warn('Invoice skipped — no contact or company linked in Bitrix24', {
        entityId,
        action: 'Open this invoice in Bitrix24 and link a Contact or Company, then it will sync on next webhook trigger'
      });
      return {
        success: true,
        skipped: true,
        reason:  'No contact or company linked to invoice in Bitrix24'
      };
    }
    // Step 2: Fetch product rows from Bitrix24 Smart Invoice
    let productRows = [];
    if (invoiceType === 'smart') {
      try {
        const { callBitrix: _callBitrix } = require('../connectors/bitrixConnector');
        let rowData = { result: [] };
        try {
          rowData = await _callBitrix('crm.productrow.list', {
            filter: { OWNER_ID: Number(entityId), OWNER_TYPE: 'SI' },
          });
          logger.info('[InvoiceProcessor] productrow fetch succeeded', { entityId, count: (rowData.result || []).length });
        } catch (e) {
          logger.info('[InvoiceProcessor] productrow fetch failed', { entityId, message: e.message });
        }
        productRows = Array.isArray(rowData.result) ? rowData.result : [];
        if (productRows.length > 0) {
          logger.info('Product rows fetched from Bitrix24 invoice', {
            entityId, count: productRows.length,
            items: productRows.map(r => `${r.PRODUCT_NAME} × ${r.QUANTITY}`).join(', ')
          });
        }
      } catch (rowErr) {
        logger.warn('Could not fetch product rows — voucher will be amount-only', { entityId, message: rowErr.message });
      }
    }

    // Step 2: Map to Tally voucher format
    const voucher = mapInvoiceToVoucher({ ...invoice, productRows });
    logger.info('Invoice mapped', {
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      amount:        voucher.amount
    });

    // Step 3: Dedup check — FIRST thing before ANY async work
    // IMMEDIATE file write to block concurrent requests from Render duplicate events
    if (!isUpdate) {
      const dedupKey = `invoice_${voucher.voucherNumber}`;
      
      // REFRESH from file before checking — must see if other process wrote dedup
      _invoiceDedupCache = loadInvoiceDedup();
      
      if (_invoiceDedupCache[dedupKey]) {
        logger.warn('Duplicate invoice blocked by dedup', { entityId, voucherNumber: voucher.voucherNumber });
        return { success: true, voucher, skipped: true };
      }
      
      _invoiceDedupCache[dedupKey] = Date.now();
      saveInvoiceDedup(_invoiceDedupCache);
    }

    // Step 3b: Ensure party ledger exists in Tally
    try {
      const { getLedgerByName, createLedger } = require('../services/tallyService');
      const existingLedger = await getLedgerByName(partyName);
      if (existingLedger) {
        logger.info('Party ledger already exists in Tally — proceeding with invoice push', { partyName });
      } else {
        logger.warn('Party ledger not found in Tally — creating as fallback (Step 1 may have been missed)', { partyName });
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Fallback ledger created for invoice push', { partyName });
      }
    } catch (ledgerErr) {
      logger.warn('Ledger check/create failed — proceeding anyway', { message: ledgerErr.message });
    }

    // Tally does not support altering existing vouchers via XML API.
    // If an invoice is updated in Bitrix24, the Sales voucher in Tally
    // will NOT be updated — manual correction required directly in Tally.
    if (isUpdate) {
      logger.warn('Invoice updated in Bitrix24 but Tally Sales voucher CANNOT be updated — Tally XML does not support voucher alter', {
        entityId,
        voucherNumber: voucher.voucherNumber,
        partyName:     voucher.partyName,
        action:        'Manual correction required in Tally if amount or date changed'
      });
      return { success: true, voucher, skipped: true };
    }

    // Step 4a: Ensure all stock items in product rows exist in Tally before creating voucher
    if (voucher.productRows && voucher.productRows.length > 0) {
      const { sendToTally: _stt } = require('../connectors/tallyConnector');
      for (const row of voucher.productRows) {
        const itemName = row.PRODUCT_NAME || row.productName || '';
        if (!itemName) continue;
        const escName = escapeXml(itemName);
        const ensureXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
          <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escName}" Action="Create">
            <NAME>${escName}</NAME>
            <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
            <BASEUNITS>Nos</BASEUNITS>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();
        try {
          await _stt(ensureXml);
          logger.info('Stock item ensured in Tally before voucher', { name: itemName });
        } catch (e) {
          logger.warn('Could not ensure stock item — voucher may fail', { name: itemName, message: e.message });
        }
      }
    }

    // Step 4: Create voucher in Tally (new invoices only)
    // Use simple voucher (without inventory) for reliability - inventory causes exceptions
    const result = await createVoucher(voucher);

    // Clear in-memory flag and write persistent dedup on success
    if (!isUpdate) {
      const dedupKey = `invoice_${voucher.voucherNumber}`;
      _invoiceDedupCache[dedupKey] = Date.now();
      saveInvoiceDedup(_invoiceDedupCache);
      logger.info('Invoice dedup cached after success', { entityId, voucherNumber: voucher.voucherNumber });
    }

    // Step 5: Store the created voucher reference for reverse sync
    try {
      const { storeMasterId } = require('../utils/voucherCache');
      const midMatch = (result || '').match(/<LASTVCHID>\s*([1-9]\d*)\s*<\/LASTVCHID>/i);
      const masterId = midMatch?.[1] || null;
      if (masterId) {
        storeMasterId(entityId, masterId, `BX-${voucher.voucherNumber}`, voucher.voucherType, {
          invoiceType: invoiceType,
          amount: voucher.amount,
          partyName: voucher.partyName
        });
      }
    } catch (cacheErr) {
      logger.warn('Invoice MASTERID cache failed', { message: cacheErr.message });
    }

    // Step 6: Attach product rows from inventory catalog back to the Bitrix24 invoice.
    //
    // This is the Feature 7 addition. When a new Smart Invoice is created in Bitrix24
    // and it doesn't yet have product rows (common when sales staff create invoices
    // manually without selecting items), we populate the rows from the Tally inventory
    // catalog that was already synced by the inventory processor.
    //
    // We only do this for Smart Invoices (entityTypeId 31) because legacy invoices
    // use a different product row API that is deprecated.
    //
    // We skip this if the invoice already has rows — no need to overwrite something
    // the user explicitly set.
    if (invoiceType === 'smart' && voucher.productRows && voucher.productRows.length > 0) {
      await _attachProductRowsIfMissing(entityId, invoice, voucher.amount);
    }


    logger.info('Invoice processor completed', {
      entityId,
      voucherNumber: voucher.voucherNumber,
      success:       result ? true : false
    });

    return { success: true, voucher };

  } catch (error) {
    // Clear dedup on failure so it can be retried
    // Guard: voucher may be undefined if error occurred before mapping
    if (!isUpdate && typeof voucher !== 'undefined' && voucher?.voucherNumber) {
      const dedupKey = `invoice_${voucher.voucherNumber}`;
      delete _invoiceDedupCache[dedupKey];
      saveInvoiceDedup(_invoiceDedupCache);
    }
    logger.error('Invoice processor failed', {
      entityId,
      message: error.message
    });
    throw error;
  }
}

// Attach product rows to a Bitrix24 Smart Invoice if it has none yet.
// Uses the Tally inventory catalog (already synced as Bitrix24 products by Feature 1).
// Falls back gracefully — a failure here never blocks the Tally voucher creation.
async function _attachProductRowsIfMissing(entityId, invoice, totalAmount) {
  try {
    const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
    if (featureGate && !featureGate.isEnabled('inventory-sync')) {
      // Inventory not synced on this plan — no product catalog to pull from
      return;
    }

    const { callBitrix } = require('../connectors/bitrixConnector');

    // Check whether this invoice already has product rows - DON'T overwrite manually entered products
    let existingRows = [];
    try {
      const rowRes = await callBitrix('crm.productrow.list', {
        filter: { OWNER_ID: Number(entityId), OWNER_TYPE: 'SI' },
      });
      existingRows = rowRes.result || [];
    } catch (e) {
      logger.info('[InvoiceProcessor] Could not check existing rows', { entityId, message: e.message });
    }

    if (existingRows.length > 0) {
      logger.info('[InvoiceProcessor] Invoice already has product rows — skipping attach', { 
        entityId, 
        count: existingRows.length 
      });
      return;
    }

    // Fetch the Bitrix24 product catalog (populated by inventory sync)
    const { fetchAllBitrixProducts } = require('../processors/inventoryProcessor');
    const products = await fetchAllBitrixProducts();

    if (!products || products.length === 0) {
      logger.info('[InvoiceProcessor] No products in Bitrix24 catalog — skipping product row attach', { entityId });
      return;
    }

    // Build a single row representing the full invoice amount.
    // We use the first product as a placeholder if no specific product can be matched.
    // When inventory-sync has run, the catalog contains Tally stock items — the most
    // relevant product to the invoice party can't be determined without line-item data,
    // so we create one row for the total. The user can refine it manually.
    //
    // If the invoice title contains a product name substring, prefer that product.
    const invoiceTitle = (invoice.title || invoice.TITLE || '').toLowerCase();
    const matchedProduct = products.find(p =>
      invoiceTitle.includes((p.NAME || '').toLowerCase()) && p.NAME.length > 2
    ) || products[0];

    const productRow = {
      PRODUCT_ID:   matchedProduct.ID,
      PRODUCT_NAME: matchedProduct.NAME,
      PRICE:        totalAmount,        // use the full invoice amount as the line price
      QUANTITY:     1,
      DISCOUNT:     0,
      CURRENCY_ID:  'INR',
    };

    // Try string ownerType first — integer ownerTypeId 400s on some Bitrix24 plans
    let setResult;
    try {
      setResult = await callBitrix('crm.item.productrow.set', {
        ownerType: 'SI',
        ownerId:   Number(entityId),
        productRows: [productRow],
      });
    } catch (setErr1) {
      if (!setErr1.message?.includes('400')) throw setErr1;
      // Fallback: try integer form
      setResult = await callBitrix('crm.item.productrow.set', {
        ownerTypeId: 31,
        ownerId:     Number(entityId),
        productRows: [productRow],
      });
    }

    logger.info('[InvoiceProcessor] Product row attached from inventory catalog', {
      entityId,
      productId:   matchedProduct.ID,
      productName: matchedProduct.NAME,
      amount:      totalAmount,
    });

  } catch (err) {
    // Non-fatal — Tally sync already completed; this is enrichment only
    logger.warn('[InvoiceProcessor] Product row attach failed — non-fatal', {
      entityId,
      message: err.message,
    });
  }
}

module.exports = { processInvoice };