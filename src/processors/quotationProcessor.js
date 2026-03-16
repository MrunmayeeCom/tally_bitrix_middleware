const { getQuote } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const quotationDedup = new Set();

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

    // Step 2: Map to Tally voucher format
    const voucher = {
      ...mapInvoiceToVoucher(quotation),
      voucherType: 'Sales Order',
      narration:   `Bitrix24 Quotation #${quotation.ID}`
    };

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

    // Tally does not support altering existing vouchers via XML API.
    // If a quotation is updated in Bitrix24, the Sales Order in Tally
    // will NOT be updated — it stays as originally created.
    // Manual correction required directly in Tally if amount or date changed.
    if (isUpdate) {
      logger.warn('Quotation updated in Bitrix24 but Tally Sales Order CANNOT be updated — Tally XML does not support voucher alter', {
        entityId,
        voucherNumber: voucher.voucherNumber,
        partyName:     voucher.partyName,
        action:        'Manual correction required in Tally if amount or date changed'
      });
      return { success: true, voucher, skipped: true };
    }

    // Step 3: Create voucher in Tally (new quotations only)
    const result = await createVoucher(voucher);
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