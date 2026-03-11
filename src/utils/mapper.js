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

  // partyName: try all known locations; if contactId/companyId > 0
  // those IDs are available for an enrichment call if needed
  const partyName =
    invoice.CLIENT_TITLE  ||
    invoice.clientTitle   ||
    (invoice.contactId  > 0 ? `Contact#${invoice.contactId}`  : null) ||
    (invoice.companyId  > 0 ? `Company#${invoice.companyId}`  : null) ||
    invoice.title         ||   // e.g. "Invoice #164" as last resort
    '';

  return {
    voucherType:   'Sales',
    voucherNumber,
    date:          dateRaw?.split('T')[0]      || '',
    partyName,
    amount:        parseFloat(amount)          || 0,
    currency:      currency                    || 'INR',
    narration:     `Bitrix24 Invoice #${id}`,
    dueDate:       closeDateRaw?.split('T')[0] || '',
    bitrixId:      String(id)
  };
}

// Map Tally Outstanding → Bitrix24 Deal fields
function mapOutstandingToDeal(outstanding) {
  const fields = {
    TITLE:           outstanding.partyName
                       ? `${outstanding.partyName} - ${outstanding.voucherNumber}`
                       : `Invoice - ${outstanding.voucherNumber}`,
    OPPORTUNITY:     outstanding.pendingAmount,
    CURRENCY_ID:     outstanding.currency || 'INR',
    CLOSEDATE:       outstanding.dueDate || '',
    COMMENTS:        `Bill Date: ${outstanding.billDate} | Days Pending: ${outstanding.daysPending}`,
    UF_BILL_DATE:    outstanding.billDate,
    UF_DUE_DATE:     outstanding.dueDate,
    UF_BILL_AMOUNT:  outstanding.billAmount,
    UF_OUTSTANDING:  outstanding.pendingAmount,
    UF_DAYS_PENDING: outstanding.daysPending
  };

  if (outstanding.bitrixContactId) fields.CONTACT_ID = outstanding.bitrixContactId;
  if (outstanding.bitrixCompanyId) fields.COMPANY_ID = outstanding.bitrixCompanyId;

  return fields;
}

module.exports = {
  mapContactToLedger,
  mapCompanyToLedger,
  mapInvoiceToVoucher,
  mapOutstandingToDeal
};