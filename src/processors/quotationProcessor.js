const { getQuote } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher, alterVoucher } = require('../services/tallyService');
const { storeMasterId, getMasterId } = require('../utils/voucherCache');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const quotationDedup = new Set();

// Track recently created vouchers: entityId → { createdAt, voucherNumber }
// Used to suppress the immediate UPDATE echo Bitrix24 fires after every ADD
const recentlyCreated = new Map();

// Track in-progress operations — prevents concurrent ADD+UPDATE race
const inFlight = new Map();

// Module-level dedup window: entityId → timestamp of last completed process
const recentlyProcessed = new Map();

async function processQuotation({ entityId, isUpdate = false }) {
  const entityKey = String(entityId);

  // Hard dedup: if another instance is actively running for this entity, wait then drop
  if (inFlight.has(entityKey)) {
    logger.info('Quotation already in-flight — waiting then dropping duplicate', { entityId });
    try { await inFlight.get(entityKey); } catch {}
    logger.info('In-flight completed — duplicate event discarded', { entityId });
    return { success: true, skipped: true, reason: 'Duplicate concurrent event dropped' };
  }

  // Soft dedup: if this entity was processed within the last 3 seconds, drop it
  const lastProcessed = recentlyProcessed.get(entityKey);
  if (lastProcessed && (Date.now() - lastProcessed) < 3000) {
    logger.info('Quotation processed too recently — dropping near-duplicate event', {
      entityId, msSinceLast: Date.now() - lastProcessed,
    });
    return { success: true, skipped: true, reason: 'Near-duplicate event within 3s window' };
  }

  let resolveInflight;
  const inflightPromise = new Promise(r => { resolveInflight = r; });
  inFlight.set(entityKey, inflightPromise);

  try {
    return await _processQuotation({ entityId, isUpdate });
  } finally {
    recentlyProcessed.set(entityKey, Date.now());
    setTimeout(() => recentlyProcessed.delete(entityKey), 5000);
    resolveInflight();
    inFlight.delete(entityKey);
  }
}

async function _processQuotation({ entityId, isUpdate = false }) {
  try {
    logger.info(`Processing quotation — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    const quotation = await getQuote(entityId);
    if (!quotation) throw new Error(`Quotation not found: ${entityId}`);

    const partyName = quotation.clientTitle || quotation.CLIENT_TITLE || '';
    if (!partyName) {
      logger.warn('Quotation skipped — no contact or company linked in Bitrix24', { entityId });
      return { success: true, skipped: true, reason: 'No contact or company linked to quotation in Bitrix24' };
    }

    try {
      const { getLedgerByName, createLedger } = require('../services/tallyService');
      const existingLedger = await getLedgerByName(partyName);
      if (!existingLedger) {
        logger.warn('Party ledger not found in Tally — creating as fallback', { partyName });
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Fallback ledger created for quotation push', { partyName });
      }
    } catch (ledgerErr) {
      logger.warn('Ledger check/create failed — proceeding anyway', { message: ledgerErr.message });
    }

    // Auto-detect voucher type
    let TALLY_SALES_ORDER_TYPE = process.env.TALLY_QUOTATION_VOUCHER_TYPE || '';
    if (!TALLY_SALES_ORDER_TYPE) {
      const { getVoucherTypes } = require('../services/tallyService');
      const availableTypes = await getVoucherTypes();
      const preferred = ['Sales Order', 'Sales Orders', 'Sales Invoice', 'Sales'];
      TALLY_SALES_ORDER_TYPE = preferred.find(t =>
        availableTypes.some(a => a.toLowerCase() === t.toLowerCase())
      ) || 'Sales Order';
      logger.info('Auto-detected Tally voucher type', { selected: TALLY_SALES_ORDER_TYPE, availableTypes });
    }

    const voucher = {
      ...mapInvoiceToVoucher(quotation),
      voucherType: TALLY_SALES_ORDER_TYPE,
      narration:   `Bitrix24 Quotation #${quotation.id || quotation.ID}`,
    };

    logger.info('Quotation mapped', {
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      amount:        voucher.amount,
      voucherType:   TALLY_SALES_ORDER_TYPE,
    });

    // ── UPDATE path ───────────────────────────────────────────────────────────
    if (isUpdate) {
      const entityKey = String(entityId);

      // Suppress Bitrix24 echo (UPDATE fired milliseconds after ADD)
      const recent = recentlyCreated.get(entityKey);
      if (recent && (Date.now() - recent.createdAt) < 20000) {
        logger.info('Skipping UPDATE — voucher was just created (Bitrix24 echo)', {
          entityId,
          voucherNumber: voucher.voucherNumber,
          ageMs: Date.now() - recent.createdAt,
        });
        return { success: true, voucher, skipped: true };
      }

      const cached = getMasterId(entityId);

      // Skip if nothing changed — prevents noise from Bitrix24 firing multiple UPDATEs
      if (
        cached &&
        String(cached.amount) === String(voucher.amount) &&
        cached.partyName === voucher.partyName
      ) {
        logger.info('Quotation unchanged — skipping Tally write', {
          entityId, amount: voucher.amount, partyName: voucher.partyName,
        });
        return { success: true, voucher, skipped: true };
      }

      // Use ALTER if we have a cached MASTERID, otherwise fall back to versioned CREATE
      if (cached?.masterId) {
        // Always verify the cached MASTERID against the live Day Book — cache can go stale
        // if a previous update created a new voucher with a new MASTERID
        let liveMasterId = cached.masterId;
        try {
          const { findMasterId } = require('../services/tallyService');
          const tallyConfig = require('../config/tallyConfig');
          const { sendToTally } = require('../connectors/tallyConnector');
          const escXml = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
          const scanned = await findMasterId(`BX-${voucher.voucherNumber}`, TALLY_SALES_ORDER_TYPE, tallyConfig, sendToTally, escXml);
          if (scanned && scanned !== cached.masterId) {
            logger.info('MASTERID in cache is stale — using live Day Book value', {
              entityId, cachedMasterId: cached.masterId, liveMasterId: scanned,
            });
            liveMasterId = scanned;
            storeMasterId(entityId, scanned, `BX-${voucher.voucherNumber}`, TALLY_SALES_ORDER_TYPE, {
              version:   cached.version || 1,
              amount:    cached.amount,
              partyName: cached.partyName,
            });
          } else if (!scanned) {
            logger.warn('Day Book scan found no voucher — will attempt alter with cached MASTERID', {
              entityId, cachedMasterId: cached.masterId,
            });
          }
        } catch (scanErr) {
          logger.warn('Live MASTERID scan failed — proceeding with cached value', {
            entityId, message: scanErr.message,
          });
        }

        logger.info('MASTERID resolved — altering existing voucher', {
          entityId, masterId: liveMasterId, voucherNumber: voucher.voucherNumber,
        });
        try {
          const result = await alterVoucher({ ...voucher, masterId: liveMasterId, entityId });
          logger.info('Quotation processor completed — altered existing voucher', {
            entityId, voucherNumber: voucher.voucherNumber,
          });
          return { success: true, voucher };
        } catch (alterErr) {
          logger.warn('ALTER failed — falling back to versioned CREATE', {
            entityId, message: alterErr.message
          });
          // Fall through to versioned CREATE below
        }
      }

      // Fallback: versioned CREATE (no cache, or alter failed)
      const version = (cached?.version || 1) + 1;
      const versionedVoucher = {
        ...voucher,
        voucherNumber: `${voucher.voucherNumber}-v${version}`,
        narration: `Bitrix24 Quotation #${entityId} (Rev ${version})`,
      };

      logger.info('Creating versioned voucher for UPDATE (alter unavailable)', {
        entityId,
        versionedVoucherNumber: versionedVoucher.voucherNumber,
        version,
        oldAmount: cached?.amount ?? 'none',
        newAmount: voucher.amount,
      });

      const result = await createVoucher(versionedVoucher);

      try {
        const midMatch = (result || '').match(/<LASTVCHID>\s*([1-9]\d*)\s*<\/LASTVCHID>/i);
        const newMid   = midMatch?.[1] || null;
        storeMasterId(entityId, newMid || '', `BX-${versionedVoucher.voucherNumber}`, TALLY_SALES_ORDER_TYPE, {
          version,
          amount:    voucher.amount,
          partyName: voucher.partyName,
        });
        logger.info('Cache updated after versioned CREATE', { entityId, newMid, version });
      } catch (cacheErr) {
        logger.warn('Cache update failed — non-fatal', { message: cacheErr.message });
      }

      recentlyCreated.set(String(entityId), { createdAt: Date.now(), voucherNumber: versionedVoucher.voucherNumber });
      setTimeout(() => recentlyCreated.delete(String(entityId)), 30000);

      logger.info('Quotation processor completed — versioned voucher created for UPDATE', {
        entityId, voucherNumber: versionedVoucher.voucherNumber,
      });
      return { success: true, voucher: versionedVoucher };
    }
        // ── CREATE path ───────────────────────────────────────────────────────────

    // Dedup within current session
    const dedupKey = `quotation_${voucher.voucherNumber}`;
    if (quotationDedup.has(dedupKey)) {
      logger.warn('Duplicate quotation webhook — skipping', { voucherNumber: voucher.voucherNumber });
      return { success: true, voucher, skipped: true };
    }
    quotationDedup.add(dedupKey);
    setTimeout(() => quotationDedup.delete(dedupKey), 60000);

    const result = await createVoucher(voucher);

    // ── Store MASTERID returned by Tally ──────────────────────────────────────
    // createVoucher returns the raw Tally XML response.
    // Extract MASTERID so future UPDATEs can skip the Day Book scan.
    try {
      const masterIdMatch  = (result || '').match(/<MASTERID>\s*(\d+)\s*<\/MASTERID>/i);
      const lastVchIdMatch = (result || '').match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i);
      const resolvedId     = (masterIdMatch?.[1] && masterIdMatch[1] !== '0')
                           ? masterIdMatch[1]
                           : (lastVchIdMatch?.[1] && lastVchIdMatch[1] !== '0')
                           ? lastVchIdMatch[1]
                           : null;
      if (resolvedId) {
        storeMasterId(entityId, resolvedId, `BX-${voucher.voucherNumber}`, TALLY_SALES_ORDER_TYPE, {
          version:   1,
          amount:    voucher.amount,
          partyName: voucher.partyName,
        });
        logger.info('MASTERID cached after CREATE', {
          entityId,
          masterId:      resolvedId,
          voucherNumber: voucher.voucherNumber,
          source:        masterIdMatch?.[1] ? 'MASTERID' : 'LASTVCHID',
        });
      } else {
        // MASTERID not in response — schedule a one-time lookup to backfill the cache
        _backfillMasterId(entityId, `BX-${voucher.voucherNumber}`, TALLY_SALES_ORDER_TYPE);
      }
    } catch (cacheErr) {
      logger.warn('Could not cache MASTERID after CREATE — non-fatal', { message: cacheErr.message });
    }

    // Mark creation time so echo-UPDATE is suppressed
    const entityKey = String(entityId);
    recentlyCreated.set(entityKey, { createdAt: Date.now(), voucherNumber: voucher.voucherNumber });
    setTimeout(() => recentlyCreated.delete(entityKey), 30000);

    // Step: Link this quotation to its parent Deal (shows in estimates section of the deal)
    try {
      const dealId = quotation.parentId || quotation.parentId2 || quotation.DEAL_ID || null;
      if (dealId && entityId) {
        const { callBitrix } = require('../connectors/bitrixConnector');
        await callBitrix('crm.item.update', {
          entityTypeId: 7,  // Quotations
          id:           Number(entityId),
          fields:       { parentId: Number(dealId) },
        });
        logger.info('Quotation linked to Deal in Bitrix24', {
          entityId,
          dealId,
          voucherNumber: voucher.voucherNumber,
        });
      } else {
        logger.info('Quotation has no parent Deal — skipping Deal link', { entityId });
      }
    } catch (dealLinkErr) {
      logger.warn('Quotation Deal link failed — non-fatal', { entityId, message: dealLinkErr.message });
    }

    logger.info('Quotation processor completed — created', {
      entityId,
      voucherNumber: voucher.voucherNumber,
    });

    return { success: true, voucher };

  } catch (error) {
    logger.error('Quotation processor failed', { entityId, message: error.message });
    throw error;
  }
}

/**
 * If Tally's CREATE response didn't include MASTERID (some versions omit it),
 * do a single targeted Day Book lookup a few seconds later and cache the result.
 * Runs async — never blocks the main flow.
 */
async function _backfillMasterId(entityId, voucherNumber, voucherType) {
  try {
    await new Promise(r => setTimeout(r, 5000)); // wait 5s for Tally to commit
    const { findMasterId, getVoucherTypes } = require('../services/tallyService');
    const tallyConfig = require('../config/tallyConfig');
    const { sendToTally } = require('../connectors/tallyConnector');
    const escapeXml = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

    const masterId = await findMasterId(voucherNumber, voucherType, tallyConfig, sendToTally, escapeXml);
    if (masterId) {
      storeMasterId(entityId, masterId, voucherNumber, voucherType);
      logger.info('MASTERID backfilled into cache', { entityId, masterId, voucherNumber });
    } else {
      logger.warn('Backfill could not find MASTERID — Day Book scan will be used on next UPDATE', { entityId, voucherNumber });
    }
  } catch (e) {
    logger.warn('MASTERID backfill failed — non-fatal', { message: e.message });
  }
}

module.exports = { processQuotation, _backfillMasterId };