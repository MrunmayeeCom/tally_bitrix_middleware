const { callBitrix } = require('../connectors/bitrixConnector');
const { processInvoice } = require('./invoiceProcessor');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_PATH = path.join(__dirname, '../../logs/invoice-cache.json');

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
    logger.warn('[InvoicePoller] Cache save failed: ' + e.message);
  }
}

function hashInvoice(item) {
  const str = [
    String(item.id || ''),
    String(item.opportunity || item.OPPORTUNITY || ''),
    String(item.contactId || item.companyId || ''),
    String(item.createdTime || item.begindate || ''),
    String(item.stageId || item.STATUS_ID || ''),
  ].join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

async function fetchSmartInvoices(start = 0) {
  const data = await callBitrix('crm.item.list', {
    entityTypeId: 31,
    select: ['id', 'opportunity', 'contactId', 'companyId', 'createdTime',
             'closeDate', 'stageId', 'currencyId', 'accountNumber'],
    order: { id: 'DESC' },
    start,
  });
  return { items: data.result?.items || [], next: data.next };
}

async function fetchLegacyInvoices(start = 0) {
  const data = await callBitrix('crm.invoice.list', {
    select: ['ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE',
             'CLOSEDATE', 'STATUS_ID', 'ACCOUNT_NUMBER'],
    order: { ID: 'DESC' },
    start,
  });
  return { items: data.result || [], next: data.next };
}

async function pollInvoices() {
  try {
    logger.info('[InvoicePoller] Starting invoice poll');

    const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
    if (featureGate && !featureGate.isEnabled('invoice-sync')) {
      logger.info('[InvoicePoller] invoice-sync not enabled on plan — skipping');
      return { processed: 0, skipped: 0 };
    }

    const cache = loadCache();
    const newCache = { ...cache };
    let processed = 0, skipped = 0, failed = 0;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // --- Smart invoices (entityTypeId 31) ---
    let start = 0;
    let hasMore = true;
    const toProcess = [];

    while (hasMore) {
      const { items, next } = await fetchSmartInvoices(start);
      for (const item of items) {
        const key = `smart_${item.id}`;
        const hash = hashInvoice(item);
        if (!cache[key] || cache[key] !== hash) {
          toProcess.push({ item, key, hash, type: 'smart' });
        }
      }
      hasMore = !!next && start < 50;
      start = next || 0;
      if (hasMore) await sleep(500);
    }

    // --- Legacy invoices ---
    start = 0;
    hasMore = true;
    while (hasMore) {
      const { items, next } = await fetchLegacyInvoices(start);
      for (const item of items) {
        const key = `legacy_${item.ID}`;
        const hash = hashInvoice({ ...item, id: item.ID, opportunity: item.OPPORTUNITY });
        if (!cache[key] || cache[key] !== hash) {
          toProcess.push({ item, key, hash, type: 'legacy', id: item.ID });
        }
      }
      hasMore = !!next && start < 50;
      start = next || 0;
      if (hasMore) await sleep(500);
    }

    logger.info(`[InvoicePoller] ${toProcess.length} invoices to process`);

    for (const { item, key, hash, type } of toProcess) {
      try {
        const id = item.id || item.ID;
        const isNew = !cache[key];
        await processInvoice(id, !isNew, type);
        newCache[key] = hash;
        processed++;
        await sleep(800);
      } catch (e) {
        logger.error('[InvoicePoller] Failed to process invoice', {
          id: item.id || item.ID, message: e.message
        });
        failed++;
      }
    }

    if (toProcess.length > 0) saveCache(newCache);
    logger.info('[InvoicePoller] Poll complete', { processed, skipped, failed });
    return { processed, skipped, failed };

  } catch (e) {
    logger.error('[InvoicePoller] Poll failed: ' + e.message);
    return { processed: 0, skipped: 0, failed: 0 };
  }
}

module.exports = { pollInvoices };