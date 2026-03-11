const { sendToTally } = require('../connectors/tallyConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

const MOCK_MODE = false; // Real Tally licensed version

// Create Ledger in Tally (skips if ledger already exists)
async function createLedger(ledger) {
  logger.info('Creating ledger in Tally', { ledgerName: ledger.ledgerName });

  // Dedup check — fetch existing ledger by name
  const existsXml = `
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
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  try {
    const existingXml = await sendToTally(existsXml);
    const namePattern = new RegExp(`<NAME>${escapeXml(ledger.ledgerName)}</NAME>`, 'i');
    if (namePattern.test(existingXml)) {
      logger.info('Ledger already exists in Tally, skipping', { ledgerName: ledger.ledgerName });
      return { skipped: true, ledgerName: ledger.ledgerName };
    }
  } catch (checkError) {
    // If dedup check fails, proceed with creation anyway
    logger.warn('Ledger dedup check failed, proceeding with create', { message: checkError.message });
  }

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
              <LEDGER NAME="${escapeXml(ledger.ledgerName)}" ACTION="Create">
                <NAME>${escapeXml(ledger.ledgerName)}</NAME>
                <PARENT>${escapeXml(ledger.groupName)}</PARENT>
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
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  return parseLedgersXml(response);
}

// Parse Tally List of Accounts XML into structured array
function parseLedgersXml(xml) {
  try {
    const ledgers = [];

    // Match each LEDGER block
    const ledgerRegex = /<LEDGER\b[^>]*>([\s\S]*?)<\/LEDGER>/gi;
    let match;

    while ((match = ledgerRegex.exec(xml)) !== null) {
      const block = match[1];

      const get = (tag) => {
        const m = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      // Also try to get NAME from the LEDGER tag attribute
      const nameAttr = /NAME="([^"]+)"/i.exec(match[0]);
      const name     = get('NAME') || (nameAttr ? nameAttr[1].trim() : '');
      const parent   = get('PARENT');

      if (!name) continue;

      // Only sync Sundry Debtors and Sundry Creditors ledgers
      // Skip system ledgers like Cash, Bank, Tax accounts etc.
      const syncGroups = ['sundry debtors', 'sundry creditors'];
      if (!syncGroups.includes(parent.toLowerCase())) continue;

      ledgers.push({
        ledgerName: name,
        groupName:  parent,
        phone:      get('LEDPHONE')    || get('PHONE')    || '',
        email:      get('LEDEMAIL')    || get('EMAIL')    || '',
      });
    }

    logger.info(`Parsed ${ledgers.length} ledgers from Tally`);
    return ledgers;

  } catch (err) {
    logger.error('Failed to parse Tally ledgers XML', { message: err.message });
    return [];
  }
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
                <PARTYLEDGERNAME>${escapeXml(voucher.partyName)}</PARTYLEDGERNAME>
                <AMOUNT>${voucher.amount}</AMOUNT>
                <NARRATION>${escapeXml(voucher.narration)}</NARRATION>
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

// Get Outstanding Bills from Tally and parse XML into structured array
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
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  return parseOutstandingXml(response);
}

// Parse Tally Bills Receivable XML into array of outstanding objects
function parseOutstandingXml(xml) {
  try {
    const bills = [];

    // TallyPrime returns BILLFIXED blocks with sibling BILLCL, BILLDUE, BILLOVERDUE
    const billRegex = /<BILLFIXED>([\s\S]*?)<\/BILLFIXED>\s*<BILLCL>(.*?)<\/BILLCL>\s*<BILLDUE>(.*?)<\/BILLDUE>\s*<BILLOVERDUE>(.*?)<\/BILLOVERDUE>/gi;
    let match;

    while ((match = billRegex.exec(xml)) !== null) {
      const block       = match[1];
      const billCl      = match[2].trim();  // negative = receivable
      const billDue     = match[3].trim();
      const billOverdue = match[4].trim();

      const get = (tag) => {
        const m = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      const partyName     = get('BILLPARTY');
      const voucherNumber = get('BILLREF');
      const billDateRaw   = get('BILLDATE');

      // BILLCL is negative for receivables (money owed to us)
      const amount = Math.abs(parseFloat(billCl)) || 0;

      if (!partyName && !voucherNumber) continue;

      bills.push({
        voucherNumber,
        partyName,
        billAmount:    amount,
        pendingAmount: amount,
        billDate:      formatTallyDateToISO(parseTallyDisplayDate(billDateRaw)),
        dueDate:       formatTallyDateToISO(parseTallyDisplayDate(billDue)),
        currency:      'INR'
      });
    }

    logger.info(`Parsed ${bills.length} outstanding bills from Tally`);
    return bills;

  } catch (err) {
    logger.error('Failed to parse Tally outstanding XML', { message: err.message });
    return [];
  }
}

// Convert Tally display date "1-Apr-25" or "1-Apr-2025" → YYYYMMDD for formatTallyDateToISO
function parseTallyDisplayDate(str) {
  if (!str) return '';
  const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                   Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const m = str.match(/(\d+)-([A-Za-z]+)-(\d+)/);
  if (!m) return '';
  const day  = m[1].padStart(2, '0');
  const mon  = months[m[2]] || '01';
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}${mon}${day}`;
}

// Convert Tally date YYYYMMDD → YYYY-MM-DD
function formatTallyDateToISO(tallyDate) {
  if (!tallyDate || tallyDate.length !== 8) return '';
  return `${tallyDate.slice(0,4)}-${tallyDate.slice(4,6)}-${tallyDate.slice(6,8)}`;
}

// Escape special XML characters in ledger/party names
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

module.exports = {
  createLedger,
  getLedgers,
  parseLedgersXml,
  createVoucher,
  getOutstanding,
  parseOutstandingXml
};