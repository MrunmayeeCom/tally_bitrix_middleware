const { getInvoice } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processInvoice(entityId) {
  try {
    logger.info('Processing invoice', { entityId });

    // Step 1: Fetch real invoice data from Bitrix24
    const invoice = await getInvoice(entityId);
    if (!invoice) throw new Error(`Invoice not found: ${entityId}`);

    // Step 2: Map to Tally voucher format
    const voucher = mapInvoiceToVoucher(invoice);
    logger.info('Invoice mapped', {
      voucherNumber: voucher.voucherNumber,
      partyName:     voucher.partyName,
      amount:        voucher.amount
    });

    // Step 3: Create voucher in Tally
    const result = await createVoucher(voucher);
    logger.info('Invoice processor completed', {
      entityId,
      voucherNumber: voucher.voucherNumber,
      success:       result ? true : false
    });

    return { success: true, voucher };

  } catch (error) {
    logger.error('Invoice processor failed', {
      entityId,
      message: error.message
    });
    throw error;
  }
}

module.exports = { processInvoice };