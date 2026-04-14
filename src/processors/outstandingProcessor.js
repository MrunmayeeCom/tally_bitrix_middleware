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
          // Helper — attach Smart Invoice to deal after create/update
        const attachInvoiceToDeal = async (dealId, outstanding) => {
          try {
            // Check if invoice already exists for this voucher
            let alreadyAttached = false;

            // Check 1: search by voucher number custom field
            try {
              const axios = require('axios');
              const bitrixConfig = require('../config/bitrixConfig');
              const res = await axios.post(
                `${bitrixConfig.webhookUrl}/crm.item.list.json`,
                {
                  entityTypeId: 31,
                  filter: { UF_TALLY_VOUCHER_NO: outstanding.voucherNumber },
                  select: ['id'],
                },
                { timeout: 8000 }
              );
              alreadyAttached = (res.data?.result?.items?.length ?? 0) > 0;
            } catch (e) {
              // UF_ field may not exist yet — fall through to title check
            }

            // Check 2: fallback search by exact title match (no UF_ dependency)
            if (!alreadyAttached) {
              try {
                const titleCheck = await callBitrix('crm.item.list', {
                  entityTypeId: 31,
                  filter: {
                    '=title': `${outstanding.partyName} - ${outstanding.voucherNumber}`,
                  },
                  select: ['id'],
                });
                alreadyAttached = (titleCheck.result?.items?.length ?? 0) > 0;
              } catch (e) {
                logger.warn('Invoice title dedup check failed — proceeding with caution', {
                  message: e.message,
                });
                // If both checks fail, do NOT proceed — safer to skip than duplicate
                alreadyAttached = true;
              }
            }

            if (alreadyAttached) {
              logger.info('Invoice already exists — skipping attach', {
                voucherNumber: outstanding.voucherNumber,
              });
              return;
            }

            // Create Smart Invoice linked to this deal
            await callBitrix('crm.item.add', {
              entityTypeId: 31,
              fields: {
                title:           `${outstanding.partyName} - ${outstanding.voucherNumber}`,
                opportunity:     outstanding.pendingAmount || 0,
                currencyId:      'INR',
                closeDate:       outstanding.dueDate || new Date().toISOString().split('T')[0],
                ...(outstanding.COMPANY_ID  ? { companyId:  outstanding.COMPANY_ID  } : {}),
                ...(outstanding.CONTACT_ID  ? { contactId:  outstanding.CONTACT_ID  } : {}),
                parentId2:       dealId, // links invoice to deal
                UF_TALLY_VOUCHER_NO: outstanding.voucherNumber,
                UF_INVOICE_NUMBER:   outstanding.voucherNumber,
                UF_INVOICE_DATE:     outstanding.billDate || '',
                UF_PAYMENT_STATUS:   'Pending',
              },
            });
            logger.info('Smart Invoice attached to deal', {
              dealId,
              voucherNumber: outstanding.voucherNumber,
            });
          } catch (e) {
            logger.warn('Could not attach invoice to deal — non-fatal', {
              dealId, message: e.message,
            });
          }
        };

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
                || currentStage.includes('payment received');

              if (isPaid) {
                delete dealFields.STAGE_ID;
                delete dealFields.UF_PAYMENT_STATUS;
                logger.info('Deal already paid — updating amounts only, stage preserved', {
                  dealId: existingDealId, stage: current.STAGE_ID,
                });
              }
            } catch (stageErr) {
              logger.warn('Could not fetch current deal stage — proceeding with full update', {
                dealId: existingDealId, message: stageErr.message,
              });
            }
            await updateDeal(existingDealId, dealFields);
            await attachInvoiceToDeal(existingDealId, outstanding);
            action = 'updated';
          } else {
            createdThisRun.add(dealKey);
            const newDeal = await createDeal(dealFields);
            const newDealId = newDeal?.result || newDeal;
            if (newDealId) {
              await attachInvoiceToDeal(newDealId, outstanding);
              await postTimelineComment(newDealId, outstanding, 'created');

              // Write to persistent dedup cache immediately so next sync skips creation
              _dealDedupCache[dealKey] = {
                dealId:    newDealId,
                createdAt: new Date().toISOString(),
                partyName: outstanding.partyName,
                voucherNumber: outstanding.voucherNumber,
              };
              saveDealDedup(_dealDedupCache);
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