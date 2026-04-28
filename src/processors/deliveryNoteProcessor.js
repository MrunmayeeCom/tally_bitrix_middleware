const { getDeliveryNotes } = require('../services/tallyService');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const { findBitrixParty } = require('./outstandingProcessor');
const { recordSync } = require('../utils/syncHistory');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/quotation-sync-cache.json');

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
    logger.warn('[QuotationSync] Cache save failed', { message: e.message });
  }
}

async function findExistingDeal(partyName) {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) return null;

    const deals = await callBitrix('crm.deal.list', {
      filter: {
        '%TITLE': partyName,
        CATEGORY_ID: categoryId,
      },
      select: ['ID', 'TITLE'],
    });

    return deals.result?.[0]?.ID || null;
  } catch (e) {
    logger.warn('[QuotationSync] Find deal failed', { partyName, message: e.message });
    return null;
  }
}

async function createEstimate(quoteData, dealId, partyMatch) {
  try {
    const result = await callBitrix('crm.item.add', {
      entityTypeId: 7,
      fields: {
        title: quoteData.title,
        opportunity: quoteData.amount || 0,
        currencyId: 'INR',
        closeDate: quoteData.date || '',
        ...(partyMatch.COMPANY_ID ? { companyId: partyMatch.COMPANY_ID } : {}),
        ...(partyMatch.CONTACT_ID ? { contactId: partyMatch.CONTACT_ID } : {}),
        parentId2: dealId,
        UF_TALLY_VOUCHER_NO: quoteData.voucherNumber,
        UF_TALLY_SYNCED: 'Y',
      },
    });
    return result.result;
  } catch (e) {
    logger.warn('[QuotationSync] Create estimate failed', { message: e.message });
    return null;
  }
}

async function processDeliveryNotes() {
  try {
    logger.info('[QuotationSync] Starting delivery note sync');

    const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
    if (featureGate && !featureGate.isEnabled('quotation-sync')) {
      logger.info('[QuotationSync] quotation-sync not enabled on plan — skipping');
      return { success: true, processed: 0, skipped: true };
    }

    const deliveryNotes = await getDeliveryNotes();
    if (!deliveryNotes || deliveryNotes.length === 0) {
      logger.info('[QuotationSync] No delivery notes found');
      return { success: true, processed: 0 };
    }

    logger.info(`[QuotationSync] Found ${deliveryNotes.length} delivery notes`);

    const cache = loadCache();
    let processed = 0;

    for (const note of deliveryNotes) {
      const key = `dn_${note.voucherNumber}`;
      if (cache[key]) {
        logger.info('[QuotationSync] Already synced — skipping', { voucherNumber: note.voucherNumber });
        continue;
      }

      const partyMatch = await findBitrixParty(note.partyName);
      if (!partyMatch.COMPANY_ID && !partyMatch.CONTACT_ID) {
        logger.warn('[QuotationSync] Party not found in Bitrix — skipping', { partyName: note.partyName });
        continue;
      }

      const dealId = await findExistingDeal(note.partyName);
      if (!dealId) {
        logger.info('[QuotationSync] No deal found for party — skipping', { partyName: note.partyName });
        continue;
      }

      const quoteData = {
        title: `${note.partyName} - ${note.voucherNumber}`,
        amount: note.amount,
        date: note.date,
        voucherNumber: note.voucherNumber,
      };

      const estimateId = await createEstimate(quoteData, dealId, partyMatch);
      if (estimateId) {
        cache[key] = { estimateId, dealId, voucherNumber: note.voucherNumber, syncedAt: new Date().toISOString() };
        processed++;
        logger.info('[QuotationSync] Estimate linked to deal', { dealId, estimateId, voucherNumber: note.voucherNumber });
      }
    }

    saveCache(cache);
    const result = { success: true, processed, trigger: 'scheduled' };
    recordSync(result);
    logger.info('[QuotationSync] Completed', { processed });
    return result;
  } catch (error) {
    logger.error('[QuotationSync] Failed', { message: error.message });
    return { success: false, processed: 0, error: error.message };
  }
}

module.exports = { processDeliveryNotes };