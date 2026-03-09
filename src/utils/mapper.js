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
function mapInvoiceToVoucher(invoice) {
  return {
    voucherType:   'Sales',
    voucherNumber: invoice.ID,
    date:          invoice.DATE_CREATE?.split('T')[0] || '',
    partyName:     invoice.CLIENT_TITLE || '',
    amount:        parseFloat(invoice.OPPORTUNITY) || 0,
    currency:      invoice.CURRENCY_ID || 'INR',
    narration:     `Bitrix24 Invoice #${invoice.ID}`,
    dueDate:       invoice.CLOSEDATE?.split('T')[0] || '',
    bitrixId:      invoice.ID
  };
}

// Map Tally Outstanding → Bitrix24 Deal fields
function mapOutstandingToDeal(outstanding) {
  return {
    TITLE:          `Invoice - ${outstanding.voucherNumber}`,
    OPPORTUNITY:    outstanding.pendingAmount,
    CURRENCY_ID:    outstanding.currency || 'INR',
    CLOSEDATE:      outstanding.dueDate || '',
    COMMENTS:       `Bill Date: ${outstanding.billDate} | Days Pending: ${outstanding.daysPending}`,
    UF_BILL_DATE:   outstanding.billDate,
    UF_DUE_DATE:    outstanding.dueDate,
    UF_BILL_AMOUNT: outstanding.billAmount,
    UF_OUTSTANDING: outstanding.pendingAmount,
    UF_DAYS_PENDING: outstanding.daysPending
  };
}

module.exports = {
  mapContactToLedger,
  mapCompanyToLedger,
  mapInvoiceToVoucher,
  mapOutstandingToDeal
};