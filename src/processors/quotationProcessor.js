const { getQuote } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processQuotation(entityId) {
  try {
    logger.info('Processing quotation', { entityId });

    // Step 1: Fetch real quotation data from Bitrix24
    const quotation = await getQuote(entityId);
    if (!quotation) throw new Error(`Quotation not found: ${entityId}`);

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

    // Step 3: Create voucher in Tally
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