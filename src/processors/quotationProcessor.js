const { getQuote } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher, alterVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const quotationDedup = new Set();

// Track recently created vouchers: voucherNumber → { createdAt, entityId }
// Used to suppress the immediate UPDATE echo Bitrix24 fires after every ADD
const recentlyCreated = new Map();

// Track in-progress operations — prevents concurrent ADD+UPDATE race
// key: entityId (string), value: Promise
const inFlight = new Map();

async function processQuotation({ entityId, isUpdate = false }) {
  const entityKey = String(entityId);

  // ── Serialise concurrent calls for the same entityId ─────────────────────
  // Bitrix24 fires ADD and UPDATE nearly simultaneously.
  // If the ADD is still running when UPDATE arrives, queue the UPDATE behind it.
  if (inFlight.has(entityKey)) {
    logger.info('Quotation already in-flight — waiting for it to finish before processing UPDATE', { entityId });
    try { await inFlight.get(entityKey); } catch {}
  }

  let resolveInflight;
  const inflightPromise = new Promise(r => { resolveInflight = r; });
  inFlight.set(entityKey, inflightPromise);

  try {
    return await _processQuotation({ entityId, isUpdate });
  } finally {
    resolveInflight();
    inFlight.delete(entityKey);
  }
}

async function _processQuotation({ entityId, isUpdate = false }) {
  try {
    logger.info(`Processing quotation — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    // Step 1: Fetch real quotation data from Bitrix24
    const quotation = await getQuote(entityId);
    if (!quotation) throw new Error(`Quotation not found: ${entityId}`);

    // Step 1b: Ensure the party ledger exists in Tally before pushing the voucher
    const partyName = quotation.clientTitle || quotation.CLIENT_TITLE || '';
    if (!partyName) {
      logger.warn('Quotation skipped — no contact or company linked in Bitrix24', {
        entityId,
        action: 'Open this quotation in Bitrix24 and link a Contact or Company, then it will sync on next webhook trigger'
      });
      return {
        success: true,
        skipped: true,
        reason:  'No contact or company linked to quotation in Bitrix24'
      };
    }

    try {
      const { getLedgerByName, createLedger } = require('../services/tallyService');
      const existingLedger = await getLedgerByName(partyName);
      if (existingLedger) {
        logger.info('Party ledger already exists in Tally — proceeding with quotation push', { partyName });
      } else {
        logger.warn('Party ledger not found in Tally — creating as fallback', { partyName });
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Fallback ledger created for quotation push', { partyName });
      }
    } catch (ledgerErr) {
      logger.warn('Ledger check/create failed — proceeding anyway', { message: ledgerErr.message });
    }

    // Auto-detect the correct voucher type from Tally if env is not set
    let TALLY_SALES_ORDER_TYPE = process.env.TALLY_QUOTATION_VOUCHER_TYPE || '';
    if (!TALLY_SALES_ORDER_TYPE) {
      const { getVoucherTypes } = require('../services/tallyService');
      const availableTypes = await getVoucherTypes();
      const preferred = ['Sales Order', 'Sales Orders', 'Sales Invoice', 'Sales'];
      TALLY_SALES_ORDER_TYPE = preferred.find(t =>
        availableTypes.some(a => a.toLowerCase() === t.toLowerCase())
      ) || 'Sales';
      logger.info('Auto-detected Tally voucher type', {
        selected: TALLY_SALES_ORDER_TYPE,
        availableTypes
      });
    }

    const voucher = {
      ...mapInvoiceToVoucher(quotation),
      voucherType: TALLY_SALES_ORDER_TYPE,
      narration:   `Bitrix24 Quotation #${quotation.id || quotation.ID}`
    };

    logger.info('Quotation mapped', {
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      amount:        voucher.amount,
      voucherType:   TALLY_SALES_ORDER_TYPE,
    });

    // ── UPDATE path ──────────────────────────────────────────────────────────
    if (isUpdate) {
      const entityKey = String(entityId);

      // Check if this voucher was JUST created (within the last 20s).
      // Bitrix24 fires an UPDATE webhook milliseconds after every ADD — this is an echo.
      const recent = recentlyCreated.get(entityKey);
      if (recent && (Date.now() - recent.createdAt) < 20000) {
        logger.info('Skipping UPDATE — voucher was just created (Bitrix24 echo)', {
          entityId,
          voucherNumber: voucher.voucherNumber,
          ageMs: Date.now() - recent.createdAt
        });
        return { success: true, voucher, skipped: true };
      }

      logger.info('Quotation UPDATE — altering existing Tally voucher', {
        entityId,
        voucherNumber: voucher.voucherNumber,
      });

      const result = await alterVoucher(voucher);
      logger.info('Quotation processor completed — altered', {
        entityId, voucherNumber: voucher.voucherNumber
      });
      return { success: true, voucher };
    }

    // ── CREATE path ──────────────────────────────────────────────────────────

    // Dedup: if this exact voucherNumber was already queued this session, skip
    const dedupKey = `quotation_${voucher.voucherNumber}`;
    if (quotationDedup.has(dedupKey)) {
      logger.warn('Duplicate quotation webhook — skipping', { voucherNumber: voucher.voucherNumber });
      return { success: true, voucher, skipped: true };
    }
    quotationDedup.add(dedupKey);
    setTimeout(() => quotationDedup.delete(dedupKey), 60000);

    const result = await createVoucher(voucher);

    // Record creation time keyed by entityId so the echo-skip check works
    // even if voucherNumber resolves differently between ADD and UPDATE callbacks
    const entityKey = String(entityId);
    recentlyCreated.set(entityKey, { createdAt: Date.now(), voucherNumber: voucher.voucherNumber });
    setTimeout(() => recentlyCreated.delete(entityKey), 30000);

    logger.info('Quotation processor completed — created', {
      entityId,
      voucherNumber: voucher.voucherNumber,
    });

    return { success: true, voucher };

  } catch (error) {
    logger.error('Quotation processor failed', {
      entityId,
      message: error.message
    });
    throw error;
  }
}

module.exports = { processQuotation };