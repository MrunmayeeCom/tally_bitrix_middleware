// ─────────────────────────────────────────
// Bitrix24 → Tally Field Mapper
// ─────────────────────────────────────────

// Map Bitrix24 Contact → Tally Ledger
function mapContactToLedger(contact) {
  const phone = contact.PHONE?.[0]?.VALUE || '';
  const email = contact.EMAIL?.[0]?.VALUE || '';
  const fullName = `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim();

  return {
    ledgerName:  fullName,
    groupName:   'Sundry Debtors',       // default Tally group
    phone:       phone,
    email:       email,
    openingBalance: 0,
    bitrixId:    contact.ID,
    bitrixType:  'contact'
  };
}

// Map Bitrix24 Company → Tally Ledger
function mapCompanyToLedger(company) {
  const phone = company.PHONE?.[0]?.VALUE || '';

  return {
    ledgerName:  company.TITLE || '',
    groupName:   'Sundry Debtors',       // default Tally group
    phone:       phone,
    openingBalance: 0,
    currency:    company.CURRENCY_ID || 'INR',
    bitrixId:    company.ID,
    bitrixType:  'company'
  };
}

// Map Bitrix24 Invoice → Tally Voucher
// Handles crm.item.get (camelCase) and legacy crm.invoice.get (UPPERCASE)
function mapInvoiceToVoucher(invoice) {
  const isCamel = invoice.id !== undefined;

  const id           = isCamel ? invoice.id           : invoice.ID;
  const dateRaw      = isCamel ? invoice.createdTime   : invoice.DATE_CREATE;
  const closeDateRaw = isCamel ? invoice.closeDate     : invoice.CLOSEDATE;
  const amount       = isCamel ? invoice.opportunity   : invoice.OPPORTUNITY;
  const currency     = isCamel ? invoice.currencyId    : invoice.CURRENCY_ID;

  // accountNumber is the Tally-facing invoice number (e.g. "81")
  // fall back to Bitrix id if not present
  const voucherNumber = invoice.accountNumber || invoice.ACCOUNT_NUMBER || String(id);

  // partyName: try all known locations; CLIENT_TITLE comes directly from Smart Invoice receipt column
  const partyName =
    invoice.CLIENT_TITLE  ||
    invoice.clientTitle   ||
    '';

  const today = new Date().toISOString().split('T')[0];
  return {
    voucherType:   process.env.TALLY_INVOICE_VOUCHER_TYPE || 'Sales',
    voucherNumber,
    date:          (dateRaw || today).split('T')[0],
    partyName,
    amount:        parseFloat(amount)          || 0,
    currency:      currency                    || 'INR',
    narration:     `Bitrix24 Invoice #${id}`,
    dueDate:       closeDateRaw?.split('T')[0] || '',
    bitrixId:      String(id),
    productRows:   invoice.productRows         || [],  // line items from Bitrix24
  };
}

// Map Tally Outstanding → Bitrix24 Deal fields
function mapOutstandingToDeal(outstanding) {
  const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
  const fullMapping = !featureGate || featureGate.isEnabled('deal-field-mapping');

  const fields = {
    TITLE:       outstanding.partyName
                   ? `${outstanding.partyName} - ${outstanding.voucherNumber}`
                   : `Invoice - ${outstanding.voucherNumber}`,
    OPPORTUNITY: outstanding.pendingAmount,
    CURRENCY_ID: outstanding.currency || 'INR',
    CLOSEDATE:   outstanding.dueDate || '',
    // Extended fields — only when deal-field-mapping is enabled
    ...(fullMapping ? {
      COMMENTS:             `Bill Date: ${outstanding.billDate} | Days Pending: ${outstanding.daysPending}`,
      UF_BILL_DATE:         outstanding.billDate,
      UF_DUE_DATE:          outstanding.dueDate,
      UF_BILL_AMOUNT:       outstanding.billAmount,
      UF_OUTSTANDING:       outstanding.pendingAmount,
      UF_DAYS_PENDING:      outstanding.daysPending,
      UF_INVOICE_NUMBER:    outstanding.voucherNumber,
      UF_INVOICE_DATE:      outstanding.billDate,
      UF_PAYMENT_STATUS:    outstanding.paymentStatus    || 'Pending',
      UF_CLOSING_STOCK:     outstanding.closingStock     || '',
    } : {})
  };

  if (outstanding.bitrixContactId) fields.CONTACT_ID = outstanding.bitrixContactId;
  if (outstanding.bitrixCompanyId) fields.COMPANY_ID = outstanding.bitrixCompanyId;
  if (outstanding.CONTACT_ID) fields.CONTACT_ID = outstanding.CONTACT_ID;
  if (outstanding.COMPANY_ID) fields.COMPANY_ID = outstanding.COMPANY_ID;

  return fields;
}

module.exports = {
  mapContactToLedger,
  mapCompanyToLedger,
  mapInvoiceToVoucher,
  mapOutstandingToDeal
};