const { getOutstanding, getLedgerByName } = require('../services/tallyService');
const { mapOutstandingToDeal } = require('../utils/mapper');
const { createDeal, updateDeal, getDeals } = require('../services/bitrixService');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const { daysPending, formatAmount } = require('../utils/helpers');
const { recordSync } = require('../utils/syncHistory');
const logger = require('../utils/logger');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-memory store — survives for lifetime of the process
let _userLimit = 0;

// ── Persistent deal dedup ─────────────────────────────────────────────────────
// Prevents re-creating deals across sync runs when the deal already exists
const fs   = require('fs');
const path = require('path');
const DEAL_DEDUP_PATH = path.join(__dirname, '../../logs/deal-dedup-cache.json');
const VOUCHER_STATE_PATH = path.join(__dirname, '../../logs/voucher-state-cache.json');

function loadDealDedup() {
  try {
    if (fs.existsSync(DEAL_DEDUP_PATH)) {
      return JSON.parse(fs.readFileSync(DEAL_DEDUP_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveDealDedup(data) {
  try {
    const dir = path.dirname(DEAL_DEDUP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEAL_DEDUP_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[OutstandingSync] Deal dedup cache save failed', { message: e.message });
  }
}

function loadVoucherState() {
  try {
    if (fs.existsSync(VOUCHER_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(VOUCHER_STATE_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveVoucherState(data) {
  try {
    const dir = path.dirname(VOUCHER_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VOUCHER_STATE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[OutstandingSync] Voucher state cache save failed', { message: e.message });
  }
}

function hasVoucherChanged(oldState, newOutstanding) {
  if (!oldState) return true;
  const oldPending = parseFloat(oldState.pendingAmount) || 0;
  const newPending = parseFloat(newOutstanding.pendingAmount) || 0;
  const oldBill = parseFloat(oldState.billAmount) || 0;
  const newBill = parseFloat(newOutstanding.billAmount) || 0;
  const oldDate = oldState.billDate || '';
  const newDate = newOutstanding.billDate || '';
  const oldDue = oldState.dueDate || '';
  const newDue = newOutstanding.dueDate || '';
  if (Math.abs(oldPending - newPending) > 0.01 || Math.abs(oldBill - newBill) > 0.01 || oldDate !== newDate || oldDue !== newDue) {
    return true;
  }
  return false;
}

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

  // Normalize party name - remove (Creditor), (Debtor), (Agent), etc. for cleaner matching
  const normalizeName = (name) => {
    if (!name) return '';
    return name.replace(/\s*\([^)]*\)\s*/g, '').trim();
  };
  const cleanName = normalizeName(partyName);

  try {
    // 1 — Search existing companies in Bitrix24 (try both original and cleaned name)
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE']
    });
    let companies = companyData.result || [];
    
    // If no match with original name, try cleaned name
    if (companies.length === 0 && cleanName !== partyName) {
      const cleanSearch = await callBitrix('crm.company.list', {
        filter: { '%TITLE': cleanName },
        select: ['ID', 'TITLE']
      });
      companies = cleanSearch.result || [];
    }
    
    if (companies.length > 0) {
      logger.info('Matched party to company', { partyName, companyId: companies[0].ID });
      const result = { COMPANY_ID: companies[0].ID };
      partyCache.set(partyName, result);
      return result;
    }

    // 2 — Search existing contacts in Bitrix24 (try both original and cleaned name)
    let contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME']
    });
    let contacts = contactData.result || [];
    
    if (contacts.length === 0 && cleanName !== partyName) {
      contactData = await callBitrix('crm.contact.list', {
        filter: { '%NAME': cleanName },
        select: ['ID', 'NAME', 'LAST_NAME']
      });
      contacts = contactData.result || [];
    }
    
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
    // Use cleaned name for Tally ledger lookup (without (Creditor), (Debtor), etc.)
    const cleanName = normalizeName(partyName);
    const fields = {
      TITLE:    partyName,
      COMMENTS: 'Auto-created from Tally outstanding sync'
    };

    let ledger = null;
    let ledgerNameFound = null;

    // Try multiple name variations to find ledger in Tally
    const nameVariations = [
      cleanName,                           // "Tally Solutions Pvt. Ltd."
      partyName.replace(/\s*\([^)]*\)\s*/g, '').trim(), // remove parentheses
      partyName.split(' ').slice(0, 2).join(' '), // first 2 words: "Tally Solutions"
      partyName.split(' ')[0],              // first word only: "Tally"
    ].filter((v, i, arr) => v && arr.indexOf(v) === i); // unique, non-empty

    if (!tallyLedgerCircuitOpen) {
      try {
        // Try each name variation until we find a match
        for (const ledgerName of nameVariations) {
          logger.info('Fetching ledger details from Tally', { partyName: ledgerName });
          ledger = await getLedgerByName(ledgerName);
          if (ledger) {
            ledgerNameFound = ledgerName;
            logger.info('Found ledger in Tally', { searchName: ledgerName, found: ledger.ledgerName });
            break;
          }
        }
        if (ledger) {
          const fgCDM = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
          const customerMapping = !fgCDM || fgCDM.isEnabled('customer-details-mapping');
          if (customerMapping) {
            if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
            if (ledger.email) fields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];
            if (ledger.gstin) fields.UF_CRM_GSTIN = ledger.gstin;
          }
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

    // Use exact TITLE match (=) not contains (%TITLE) to prevent
    // "ABC - 001" matching "ABC - 0011" and causing false negatives
    const data = await callBitrix('crm.deal.list', {
      filter: {
        '=TITLE':    fullTitle,
        CATEGORY_ID: categoryId,
      },
      select: ['ID', 'TITLE'],
    });
    const deals = data.result || [];

    // Extra safety: verify title matches exactly (Bitrix24 ignores = on some plans)
    const exact = deals.find(
      d => (d.TITLE || '').trim().toLowerCase() === fullTitle.trim().toLowerCase()
    );

    if (exact) {
      logger.info('Existing deal found (exact match)', { dealId: exact.ID, title: fullTitle });
      return exact.ID;
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
      // Skip already closed/won/paid deals — never downgrade a won deal
      const stageNameLower = Object.entries(stageMap).find(([, v]) => v === deal.STAGE_ID)?.[0] || '';
      const isProtectedStage = deal.STAGE_ID === 'WON'
        || deal.STAGE_ID === paidStageId
        || stageNameLower.includes('won')
        || stageNameLower.includes('payment received')
        || stageNameLower.includes('closed');
      if (isProtectedStage) continue;

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

    // Gate: bill-as-deal — if disabled, skip entire outstanding sync
    try {
      const featureGate = require('../services/featureGate');
      if (!featureGate.isEnabled('bill-as-deal')) {
        logger.info('[LMS] bill-as-deal not enabled on plan — skipping outstanding sync');
        return { success: true, processed: 0, skipped: true };
      }
    } catch {}

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

    // Load inventory snapshot for closing stock enrichment
    let _inventoryMap = {};
    try {
      const { getLastMatchResult } = require('./inventoryMatcher');
      const matchResult = getLastMatchResult();
      if (matchResult && matchResult.lastRun) {
        // Build map: partyName is not directly linked to stock,
        // but we store total closing stock value for the active company
        const allItems = [
          ...(matchResult.discrepancies || []),
          ...(matchResult.onlyInTally   || []),
        ];
        allItems.forEach(item => {
          _inventoryMap[item.name.toLowerCase()] = item.tallyQty;
        });
        logger.info(`[OutstandingSync] Inventory map loaded — ${Object.keys(_inventoryMap).length} items`);
      }
    } catch (e) {
      logger.warn('[OutstandingSync] Could not load inventory map — closing stock will be blank', {
        message: e.message,
      });
    }

    // Step 1: Fetch outstanding bills from Tally
    const outstandingList = await getOutstanding();

    if (!outstandingList || outstandingList.length === 0) {
      logger.info('No outstanding bills found');
      // Do NOT call closePaidDeals with empty list — if Tally returned nothing
      // it may be offline or have no data, and we must not mark all deals as paid.
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

        // Skip bills that were created from Bitrix (BX- prefix) — don't create reverse deals
        if (outstanding.voucherNumber?.startsWith('BX-')) {
          logger.info('Skipping Bitrix-originated voucher — no reverse deal', {
            voucherNumber: outstanding.voucherNumber,
            partyName: outstanding.partyName,
          });
          return;
        }

        outstanding.daysPending   = daysPending(outstanding.dueDate);
        outstanding.pendingAmount = formatAmount(outstanding.pendingAmount);
        outstanding.billAmount    = formatAmount(outstanding.billAmount);

        // Enrich with closing stock summary if inventory was previously synced
        // Stored as a compact string: "Item A: 10, Item B: 5"
        if (Object.keys(_inventoryMap).length > 0) {
          const stockLines = Object.entries(_inventoryMap)
            .filter(([, qty]) => qty > 0)
            .slice(0, 5)  // cap at 5 items to keep field readable
            .map(([name, qty]) => `${name}: ${qty}`);
          outstanding.closingStock = stockLines.join(' | ') || '';
        }

        const partyMatch = await findBitrixParty(outstanding.partyName);
        Object.assign(outstanding, partyMatch);

        const dealFields     = mapOutstandingToDeal(outstanding, false);
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

        // Check persistent dedup cache FIRST — avoids an API call for already-known deals
        const _dealDedupCache = loadDealDedup();
        const existingDealId = _dealDedupCache[dealKey]?.dealId
          || await findExistingDeal(outstanding.partyName, outstanding.voucherNumber);

        if (_dealDedupCache[dealKey]) {
          logger.info('[OutstandingSync] Deal known from persistent cache — skipped API lookup', {
            dealKey,
            cachedDealId: _dealDedupCache[dealKey].dealId,
          });
        }
let action;

        try {
          // Helper — post timeline comment with bill details
        const postTimelineComment = async (dealId, outstanding, action) => {
          try {
            const comment =
              `Tally Bill Synced (${action})\n` +
              `Invoice No: ${outstanding.voucherNumber}\n` +
              `Bill Date: ${outstanding.billDate || '—'}\n` +
              `Bill Amount: ₹${outstanding.billAmount || 0}\n` +
              `Outstanding: ₹${outstanding.pendingAmount || 0}\n` +
              `Days Pending: ${outstanding.daysPending || 0}\n` +
              `Due Date: ${outstanding.dueDate || '—'}`;

            await callBitrix('crm.timeline.comment.add', {
              fields: {
                ENTITY_TYPE: 'deal',
                ENTITY_ID:   dealId,
                COMMENT:     comment,
              },
            });
          } catch (e) {
            // Timeline comment failure is non-fatal
          }
        };

        
            if (existingDealId) {
            try {
              const currentDeal = await callBitrix('crm.deal.get', { id: existingDealId });
              const current = currentDeal.result || {};
              const currentStage   = (current.STAGE_ID        || '').toLowerCase();
              const currentPayment = (current.UF_PAYMENT_STATUS || '').toLowerCase();

    const isPaid = currentPayment === 'paid'
      || currentStage.includes('won')
      || currentStage.includes('payment received')
      || currentStage.includes('closed');

    const isManuallyMoved = currentStage.includes('follow up')
      || currentStage.includes('followup')
      || currentStage.includes('overdue')
      || currentStage.includes('new bill');

    if (isPaid || isManuallyMoved) {
      delete dealFields.STAGE_ID;
      if (isPaid) delete dealFields.UF_PAYMENT_STATUS;
      logger.info('Deal stage preserved — not overwriting with sync', {
        dealId: existingDealId, stage: current.STAGE_ID, isPaid, isManuallyMoved,
      });
    }
            } catch (stageErr) {
              logger.warn('Could not fetch current deal stage — proceeding with full update', {
                dealId: existingDealId, message: stageErr.message,
              });
            }
            const _voucherState = loadVoucherState();
            const prevState = _voucherState[dealKey];
            const voucherChanged = hasVoucherChanged(prevState, outstanding);
            if (!voucherChanged) {
              delete dealFields.OPPORTUNITY;
              delete dealFields.CLOSEDATE;
              delete dealFields.COMMENTS;
              delete dealFields.UF_BILL_DATE;
              delete dealFields.UF_DUE_DATE;
              delete dealFields.UF_BILL_AMOUNT;
              delete dealFields.UF_OUTSTANDING;
              delete dealFields.UF_DAYS_PENDING;
              delete dealFields.UF_INVOICE_DATE;
              logger.info('Deal unchanged — skipping update (voucher state same)', {
                dealId: existingDealId, voucherNumber: outstanding.voucherNumber,
              });
            } else {
              _voucherState[dealKey] = {
                billDate: outstanding.billDate,
                dueDate: outstanding.dueDate,
                billAmount: outstanding.billAmount,
                pendingAmount: outstanding.pendingAmount,
                syncedAt: new Date().toISOString(),
              };
              saveVoucherState(_voucherState);
              logger.info('Voucher changed — updating deal', {
                dealId: existingDealId, voucherNumber: outstanding.voucherNumber, prev: prevState, new: outstanding.pendingAmount,
              });
            }
            await updateDeal(existingDealId, dealFields);
            action = 'updated';
          } else {
            createdThisRun.add(dealKey);
            // Generate dealFields with STAGE_ID for new deals only
            const newDealFields = mapOutstandingToDeal(outstanding, true);
            const newDeal = await createDeal(newDealFields);
            const newDealId = newDeal?.result || newDeal;
            if (newDealId) {
              await postTimelineComment(newDealId, outstanding, 'created');

              _dealDedupCache[dealKey] = {
                dealId:    newDealId,
                createdAt: new Date().toISOString(),
                partyName: outstanding.partyName,
                voucherNumber: outstanding.voucherNumber,
              };
              saveDealDedup(_dealDedupCache);

              const _voucherState = loadVoucherState();
              _voucherState[dealKey] = {
                billDate: outstanding.billDate,
                dueDate: outstanding.dueDate,
                billAmount: outstanding.billAmount,
                pendingAmount: outstanding.pendingAmount,
                syncedAt: new Date().toISOString(),
              };
              saveVoucherState(_voucherState);
            }
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