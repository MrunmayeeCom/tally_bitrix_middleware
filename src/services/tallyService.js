const { sendToTally } = require('../connectors/tallyConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

const MOCK_MODE = false; // Real Tally licensed version

// Create Ledger in Tally
async function createLedger(ledger) {
  logger.info('Creating ledger in Tally', { ledgerName: ledger.ledgerName });

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Import Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <IMPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>All Masters</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
            </STATICVARIABLES>
          </REQUESTDESC>
          <REQUESTDATA>
            <TALLYMESSAGE xmlns:UDF="TallyUDF">
              <LEDGER NAME="${ledger.ledgerName}" ACTION="Create">
                <NAME>${ledger.ledgerName}</NAME>
                <PARENT>${ledger.groupName}</PARENT>
                <OPENINGBALANCE>${ledger.openingBalance}</OPENINGBALANCE>
              </LEDGER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  logger.info('Ledger created in Tally', { ledgerName: ledger.ledgerName });
  return response;
}

// Get all Ledgers from Tally
async function getLedgers() {
  logger.info('Fetching ledgers from Tally');

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>List of Accounts</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  return response;
}

// Create Voucher in Tally (Invoice)
async function createVoucher(voucher) {
  logger.info('Creating voucher in Tally', { voucherNumber: voucher.voucherNumber });

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Import Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <IMPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>Vouchers</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
            </STATICVARIABLES>
          </REQUESTDESC>
          <REQUESTDATA>
            <TALLYMESSAGE xmlns:UDF="TallyUDF">
              <VOUCHER VCHTYPE="${voucher.voucherType}" ACTION="Create">
                <DATE>${voucher.date.replace(/-/g, '')}</DATE>
                <VOUCHERTYPENAME>${voucher.voucherType}</VOUCHERTYPENAME>
                <PARTYLEDGERNAME>${voucher.partyName}</PARTYLEDGERNAME>
                <AMOUNT>${voucher.amount}</AMOUNT>
                <NARRATION>${voucher.narration}</NARRATION>
              </VOUCHER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  logger.info('Voucher created in Tally', { voucherNumber: voucher.voucherNumber });
  return response;
}

// Get Outstanding Bills from Tally
async function getOutstanding() {
  logger.info('Fetching outstanding bills from Tally');

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>Bills Receivable</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  return response;
}

module.exports = {
  createLedger,
  getLedgers,
  createVoucher,
  getOutstanding
};