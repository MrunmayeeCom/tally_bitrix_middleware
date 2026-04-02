const { getQuote } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher, alterVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const quotationDedup = new Set();
const recentlyCreated = new Map();

async function processQuotation({ entityId, isUpdate = false }) {
  try {
    logger.info(`Processing quotation — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    // Step 1: Fetch real quotation data from Bitrix24
    const quotation = await getQuote(entityId);
    if (!quotation) throw new Error(`Quotation not found: ${entityId}`);

    // Step 1b: Ensure the party ledger exists in Tally before pushing the voucher
    const partyName = quotation.clientTitle || quotation.CLIENT_TITLE || '';
    if (!partyName) {
      // Cannot push to Tally without a party name — Tally requires a ledger
      // on every Sales Order voucher. Skipping and logging clearly so the
      // user knows to link a contact in Bitrix24.
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
    // Per requirements, ledger should already exist from Step 1
    // (Company/Contact Created → Ledger Created in Tally).
    // Fallback: create it here if Step 1 was missed.
    try {
      const { getLedgerByName, createLedger } = require('../services/tallyService');
      const existingLedger = await getLedgerByName(partyName);
      if (existingLedger) {
        logger.info('Party ledger already exists in Tally — proceeding with quotation push', { partyName });
      } else {
        logger.warn('Party ledger not found in Tally — creating as fallback (Step 1 may have been missed)', { partyName });
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
    logger.info('Voucher type resolution', { availableTypes, selected: TALLY_SALES_ORDER_TYPE });
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

    logger.info('Quotation voucher type being used', {
      voucherType:   TALLY_SALES_ORDER_TYPE,
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      hint:          'If Tally rejects silently, verify this name in Tally → Accounts Info → Voucher Types'
    });

    logger.info('Quotation mapped', {
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      amount:        voucher.amount
    });

    // Step 3: Check dedup before creating voucher in Tally
    if (!isUpdate) {
      const dedupKey = `quotation_${voucher.voucherNumber}`;
      if (quotationDedup.has(dedupKey)) {
        logger.warn('Duplicate quotation webhook — skipping', { voucherNumber: voucher.voucherNumber });
        return { success: true, voucher, skipped: true };
      }
      quotationDedup.add(dedupKey);
      setTimeout(() => quotationDedup.delete(dedupKey), 60000); // clear after 60s
    }

    if (isUpdate) {
      // Wait 5s — ADD and UPDATE webhooks fire simultaneously from Bitrix24
      await new Promise(r => setTimeout(r, 5000));

      // If this voucher was just created in the last 15s, the UPDATE is a Bitrix24 echo — skip
      const createdAt = recentlyCreated.get(String(voucher.voucherNumber));
      if (createdAt && (Date.now() - createdAt) < 15000) {
        logger.info('Skipping alter — voucher was just created, UPDATE is a Bitrix24 echo', {
          entityId, voucherNumber: voucher.voucherNumber
        });
        return { success: true, voucher, skipped: true };
      }

      logger.info('Quotation updated — altering existing Tally voucher in place', {
        entityId, voucherNumber: voucher.voucherNumber
      });
      const result = await alterVoucher(voucher);
      logger.info('Quotation processor completed', {
        entityId, voucherNumber: voucher.voucherNumber, success: true, action: 'altered'
      });
      return { success: true, voucher };
    }

    // Create voucher in Tally (new quotations only)
    const result = await createVoucher(voucher);
    recentlyCreated.set(String(voucher.voucherNumber), Date.now());
    setTimeout(() => recentlyCreated.delete(String(voucher.voucherNumber)), 30000);
    logger.info('Quotation processor completed', {
      entityId,
      voucherNumber: voucher.voucherNumber,
      success:       result ? true : false
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