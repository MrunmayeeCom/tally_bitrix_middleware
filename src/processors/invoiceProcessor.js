const { getInvoice } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processInvoice(entityId, isUpdate = false) {
  try {
    logger.info(`Processing invoice — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    // Step 1: Fetch real invoice data from Bitrix24
    const invoice = await getInvoice(entityId);
    if (!invoice) throw new Error(`Invoice not found: ${entityId}`);

    // Step 1b: Ensure the party ledger exists in Tally before pushing the voucher
    const partyName = invoice.clientTitle || invoice.CLIENT_TITLE || '';
    if (partyName) {
      try {
        const { createLedger } = require('../services/tallyService');
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Party ledger ensured in Tally before invoice push', { partyName });
      } catch (ledgerErr) {
        logger.warn('Could not ensure party ledger — proceeding anyway', { message: ledgerErr.message });
      }
    }

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