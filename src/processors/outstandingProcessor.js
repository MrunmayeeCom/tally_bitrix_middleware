const { getOutstanding, getLedgerByName } = require('../services/tallyService');
const { mapOutstandingToDeal } = require('../utils/mapper');
const { createDeal, updateDeal, getDeals } = require('../services/bitrixService');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const { daysPending, formatAmount } = require('../utils/helpers');
const { recordSync } = require('../utils/syncHistory');
const logger = require('../utils/logger');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Process items in small parallel batches instead of one-by-one
async function processInBatches(items, handler, batchSize = 3) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(handler));
    await sleep(300);
  }
}

// Per-sync-run cache — avoids hitting Tally/Bitrix multiple times for same party
const partyCache = new Map();

// Circuit breaker — if Tally fails once during a sync run, stop trying it for ledger lookups
let tallyLedgerCircuitOpen = false;


async function findBitrixParty(partyName) {
  if (!partyName) return {};

  // Return cached result if we already looked this party up this sync run
  if (partyCache.has(partyName)) {
    return partyCache.get(partyName);
  }

  try {
    // 1 — Search existing companies in Bitrix24
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE']
    });
    const companies = companyData.result || [];
    if (companies.length > 0) {
      logger.info('Matched party to company', { partyName, companyId: companies[0].ID });
      const result = { COMPANY_ID: companies[0].ID };
      partyCache.set(partyName, result);
      return result;
    }

    // 2 — Search existing contacts in Bitrix24 (unregistered parties created as contacts)
    const contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME']
    });
    const contacts = contactData.result || [];
    const matchedContact = contacts.find(c =>
      `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim().toLowerCase() === partyName.toLowerCase()
    );
    if (matchedContact) {
      logger.info('Matched party to contact', { partyName, contactId: matchedContact.ID });
      const result = { CONTACT_ID: matchedContact.ID };
      partyCache.set(partyName, result);
      return result;
    }

    // 3 — Not found in Bitrix24 — fetch ledger from Tally for enrichment + GST classification
    const fields = {
      TITLE:    partyName,
      COMMENTS: 'Auto-created from Tally outstanding sync'
    };

    let ledger = null;

    if (!tallyLedgerCircuitOpen) {
      try {
        logger.info('Fetching ledger details from Tally', { partyName });
        ledger = await getLedgerByName(partyName);
        if (ledger) {
          if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
          if (ledger.email) fields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];
          if (ledger.gstin) fields.UF_CRM_GSTIN = ledger.gstin;
          logger.info('Ledger enrichment successful', {
            partyName,
            phone:   ledger.phone   || '—',
            email:   ledger.email   || '—',
            gstin:   ledger.gstin   || '—',
            gstType: ledger.gstType || '—'
          });
        } else {
          logger.warn('Ledger not found in Tally — bare record will be created', { partyName });
        }
      } catch (tallyErr) {
        tallyLedgerCircuitOpen = true;
        logger.warn('Tally unreachable — circuit opened, remaining parties created bare', {
          partyName, message: tallyErr.message
        });
      }
    } else {
      logger.info('Tally circuit open — skipping ledger fetch', { partyName });
    }

    // 4 — Decide: Company or Contact?
    // Use Tally's GST registration type — no guessing from name.
    // Registered GST entity → Company. Unregistered / no GSTIN → Contact.
    const gstin   = (ledger && ledger.gstin)   ? ledger.gstin   : '';
    const gstType = (ledger && ledger.gstType) ? ledger.gstType.toLowerCase().trim() : '';

    const registeredTypes = ['regular', 'composition', 'sez', 'sez developer',
                             'deemed export', 'uin holders', 'overseas'];
    // If ledger not found or Tally unreachable — default to Company
    // Most Rajlaxmi parties are businesses, so Company is the safer default
    const isRegisteredBusiness = !ledger || gstin.length === 15 || registeredTypes.includes(gstType);

    let newId, result;

    if (isRegisteredBusiness) {
      // Registered GST entity → Bitrix24 Company
      const newCompany = await callBitrix('crm.company.add', { fields });
      newId  = newCompany.result;
      result = { COMPANY_ID: newId };
      logger.info('Company created in Bitrix24 — registered GST entity', {
        partyName, companyId: newId, gstin, gstType
      });
    } else {
      // Unregistered → Bitrix24 Contact
      const nameParts = partyName.trim().split(/\s+/);
      const contactFields = {
        NAME:      nameParts[0],
        LAST_NAME: nameParts.slice(1).join(' ') || '',
        SOURCE_ID: 'OTHER',
        COMMENTS:  'Auto-created from Tally outstanding sync'
      };
      if (fields.PHONE) contactFields.PHONE = fields.PHONE;
      if (fields.EMAIL) contactFields.EMAIL = fields.EMAIL;

      const newContact = await callBitrix('crm.contact.add', { fields: contactFields });
      newId  = newContact.result;
      result = { CONTACT_ID: newId };
      logger.info('Contact created in Bitrix24 — unregistered party', {
        partyName, contactId: newId, gstType: gstType || 'blank'
      });
    }

    partyCache.set(partyName, result);
    return result;

  } catch (e) {
    logger.warn('Party lookup/create failed', { partyName, message: e.message });
  }

  return {};
}

async function findExistingDeal(partyName, voucherNumber) {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    const fullTitle = `${partyName} - ${voucherNumber}`;
    const data = await callBitrix('crm.deal.list', {
      filter: {
        TITLE:       fullTitle,
        CATEGORY_ID: categoryId
      },
      select: ['ID', 'TITLE']
    });
    const deals = data.result || [];
    if (deals.length > 0) {
      logger.info('Existing deal found', { dealId: deals[0].ID, title: fullTitle });
      return deals[0].ID;
    }
  } catch (e) {
    logger.warn('Existing deal lookup failed', { voucherNumber, message: e.message });
  }
  return null;
}

async function closePaidDeals(currentVoucherNumbers) {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) return;

    const { getDealsInPipeline } = require('../services/bitrixService');
    const { getStages } = require('../services/bitrixService');

    const deals = await getDealsInPipeline(categoryId);
    const stages = await getStages(categoryId);
    const stageMap = {};
    stages.forEach(s => { stageMap[(s.NAME||s.name).toLowerCase()] = s.STATUS_ID || s.id; });
    const paidStageId = stageMap['payment received'];

    for (const deal of deals) {
      // Skip already closed/won deals
      if (deal.STAGE_ID === 'WON' || deal.STAGE_ID === paidStageId) continue;

      // Check if this deal's voucher is still outstanding
      const titleParts = (deal.TITLE || '').split(' - ');
      const voucherNum = titleParts[titleParts.length - 1];
      const stillOutstanding = currentVoucherNumbers.includes(voucherNum);

      if (!stillOutstanding && paidStageId) {
        await updateDeal(deal.ID, { STAGE_ID: paidStageId });
        logger.info('Deal moved to Payment Received — bill cleared in Tally', {
          dealId: deal.ID, title: deal.TITLE
        });
      }
    }
  } catch (e) {
    logger.warn('closePaidDeals check failed', { message: e.message });
  }
}

async function processOutstanding() {
  try {
    logger.info('Outstanding sync started');

    // Enforce user-limit — cap how many unique parties are synced
    let _userLimit = 0;
    try {
      const featureGate = require('../services/featureGate');
      _userLimit = featureGate.getLimit('user-limit', 0);
      const companyLimit = featureGate.getLimit('company-limit', 1);
      logger.info(`[LMS] Plan limits — user-limit: ${_userLimit || 'unlimited'} | company-limit: ${companyLimit}`);
    } catch {}


    // Reset per-run cache, circuit breaker, and dedup set
    partyCache.clear();
    tallyLedgerCircuitOpen = false;
    const createdThisRun = new Set();
    const inFlightVouchers = new Set();
    logger.info('Per-run state reset — cache, circuit breaker, dedup cleared');

    // Step 1: Fetch outstanding bills from Tally
    const outstandingList = await getOutstanding();

    if (!outstandingList || outstandingList.length === 0) {
      logger.info('No outstanding bills found');
      await closePaidDeals([]);
      return { success: true, processed: 0 };
    }

    logger.info(`Found ${outstandingList.length} outstanding bills`);

    let processed = 0;
    let failed    = 0;

    let _syncedParties = new Set();

    await processInBatches(outstandingList, async (outstanding) => {
      try {
        // Enforce user-limit — stop syncing new parties once limit reached
        if (_userLimit > 0 && _syncedParties.size >= _userLimit) {
          if (!_syncedParties.has(outstanding.partyName)) {
            logger.warn(`[LMS] user-limit (${_userLimit}) reached — skipping new party`, { partyName: outstanding.partyName });
            return;
          }
        }
        _syncedParties.add(outstanding.partyName);
        outstanding.daysPending   = daysPending(outstanding.dueDate);
        outstanding.pendingAmount = formatAmount(outstanding.pendingAmount);
        outstanding.billAmount    = formatAmount(outstanding.billAmount);

        const partyMatch = await findBitrixParty(outstanding.partyName);
        Object.assign(outstanding, partyMatch);

        const dealFields     = mapOutstandingToDeal(outstanding);
        const dealKey = `${outstanding.partyName}||${outstanding.voucherNumber}`;

        // Duplicate prevention — only if enabled on plan
        const featureGateDP = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
        const dedupEnabled = !featureGateDP || featureGateDP.isEnabled('duplicate-prevention');

        if (dedupEnabled) {
          // Guard 1: skip if another parallel batch item is already creating this deal
          if (inFlightVouchers.has(dealKey)) {
            logger.warn('Duplicate in-flight — skipping', { dealKey });
            return;
          }
          // Guard 2: skip if this deal was already created earlier in this sync run
          if (createdThisRun.has(dealKey)) {
            logger.warn('Already created this run — skipping duplicate', { dealKey });
            processed++;
            return;
          }
        }

        inFlightVouchers.add(dealKey);
        const existingDealId = await findExistingDeal(outstanding.partyName, outstanding.voucherNumber);
        let action;

        try {
          if (existingDealId) {
            await updateDeal(existingDealId, dealFields);
            action = 'updated';
          } else {
            createdThisRun.add(dealKey);
            await createDeal(dealFields);
            action = 'created';
          }
        } finally {
          inFlightVouchers.delete(dealKey);
        }

        logger.info(`Outstanding bill ${action} in Bitrix24`, {
          voucherNumber: outstanding.voucherNumber,
          partyName:     outstanding.partyName,
          pendingAmount: outstanding.pendingAmount,
          daysPending:   outstanding.daysPending,
          action
        });

        processed++;
      } catch (itemError) {
        logger.error('Failed to process outstanding bill', {
          voucherNumber: outstanding.voucherNumber,
          message:       itemError.message
        });
        failed++;
      }
    }, 3); // 3 bills processed in parallel per batch

   const currentVoucherNumbers = outstandingList.map(o => String(o.voucherNumber));
    await closePaidDeals(currentVoucherNumbers);

    const syncResult = { success: true, processed, failed, trigger: 'scheduled' };
    recordSync(syncResult);
    logger.info('Outstanding sync completed', { processed, failed });
    return syncResult;
  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('Outstanding sync skipped — Tally is not running');
      return { success: true, processed: 0, failed: 0, skipped: true };
    }
    logger.error('Outstanding processor failed', { message: error.message });
    throw error;
  }
}

module.exports = { processOutstanding };