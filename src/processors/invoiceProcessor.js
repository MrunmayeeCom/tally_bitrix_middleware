const { getInvoice } = require('../services/bitrixService');
const { mapInvoiceToVoucher } = require('../utils/mapper');
const { createVoucher } = require('../services/tallyService');
const logger = require('../utils/logger');

// In-memory dedup set — prevents duplicate vouchers if webhook fires twice within 60s
const invoiceDedup = new Set();

async function processInvoice(entityId, isUpdate = false, invoiceType = 'smart') {
  try {
    logger.info(`Processing invoice — ${isUpdate ? 'UPDATE' : 'CREATE'} — type: ${invoiceType}`, { entityId });

    // Step 1: Fetch real invoice data from Bitrix24
    const invoice = await getInvoice(entityId, invoiceType);
    if (!invoice) throw new Error(`Invoice not found: ${entityId}`);

    // Step 1b: Ensure the party ledger exists in Tally before pushing the voucher
    const partyName = invoice.clientTitle || invoice.CLIENT_TITLE || '';
    if (!partyName) {
      logger.warn('Invoice skipped — no contact or company linked in Bitrix24', {
        entityId,
        action: 'Open this invoice in Bitrix24 and link a Contact or Company, then it will sync on next webhook trigger'
      });
      return {
        success: true,
        skipped: true,
        reason:  'No contact or company linked to invoice in Bitrix24'
      };
    }
    try {
      const { getLedgerByName, createLedger } = require('../services/tallyService');
      const existingLedger = await getLedgerByName(partyName);
      if (existingLedger) {
        logger.info('Party ledger already exists in Tally — proceeding with invoice push', { partyName });
      } else {
        logger.warn('Party ledger not found in Tally — creating as fallback (Step 1 may have been missed)', { partyName });
        await createLedger({ ledgerName: partyName, groupName: 'Sundry Debtors', openingBalance: 0 });
        logger.info('Fallback ledger created for invoice push', { partyName });
      }
    } catch (ledgerErr) {
      logger.warn('Ledger check/create failed — proceeding anyway', { message: ledgerErr.message });
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

    // Tally does not support altering existing vouchers via XML API.
    // If an invoice is updated in Bitrix24, the Sales voucher in Tally
    // will NOT be updated — manual correction required directly in Tally.
    if (isUpdate) {
      logger.warn('Invoice updated in Bitrix24 but Tally Sales voucher CANNOT be updated — Tally XML does not support voucher alter', {
        entityId,
        voucherNumber: voucher.voucherNumber,
        partyName:     voucher.partyName,
        action:        'Manual correction required in Tally if amount or date changed'
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