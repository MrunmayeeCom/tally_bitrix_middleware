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
    if (quotation.clientTitle || quotation.CLIENT_TITLE) {
      const partyName = quotation.clientTitle || quotation.CLIENT_TITLE;
      try {
        const { createLedger } = require('../services/tallyService');
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Party ledger ensured in Tally before quotation push', { partyName });
      } catch (ledgerErr) {
        logger.warn('Could not ensure party ledger — proceeding anyway', { message: ledgerErr.message });
      }
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

    // Step 3: On update — skip voucher creation, Tally doesn't support voucher alter via XML
    if (isUpdate) {
      logger.info('Quotation update — voucher alter not supported via Tally XML, skipping voucher push', {
        entityId, voucherNumber: voucher.voucherNumber
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