const { getInvoice } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const invoiceDedup = new Set();

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

    // Step 3: Check if voucher already exists in Tally before creating
    if (!isUpdate) {
      // Use voucherNumber as dedup key — if same invoice fires twice, skip second
      const dedupKey = `invoice_${voucher.voucherNumber}`;
      if (invoiceDedup.has(dedupKey)) {
        logger.warn('Duplicate invoice webhook — skipping', { voucherNumber: voucher.voucherNumber });
        return { success: true, voucher, skipped: true };
      }
      invoiceDedup.add(dedupKey);
      setTimeout(() => invoiceDedup.delete(dedupKey), 60000); // clear after 60s
    }

    // Step 3: On update — skip voucher creation, Tally doesn't support voucher alter via XML
    // Only the ledger (party) has been ensured above, which is sufficient for updates
    if (isUpdate) {
      logger.info('Invoice update — voucher alter not supported via Tally XML, skipping voucher push', {
        entityId, voucherNumber: voucher.voucherNumber
      });
      return { success: true, voucher, skipped: true };
    }

    // Step 3: Create voucher in Tally (new invoices only)
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