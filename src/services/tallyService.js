const { sendToTally } = require('../connectors/tallyConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

const MOCK_MODE = false; // Real Tally licensed version

// Create Ledger in Tally (skips if ledger already exists)
async function createLedger(ledger) {
  logger.info('Creating ledger in Tally', { ledgerName: ledger.ledgerName });

  // // Dedup check — fetch existing ledger by name
  // const existsXml = `
  //   <ENVELOPE>
  //     <HEADER>
  //       <TALLYREQUEST>Export Data</TALLYREQUEST>
  //     </HEADER>
  //     <BODY>
  //       <EXPORTDATA>
  //         <REQUESTDESC>
  //           <REPORTNAME>List of Accounts</REPORTNAME>
  //           <STATICVARIABLES>
  //             <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
  //             <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
  //           </STATICVARIABLES>
  //         </REQUESTDESC>
  //       </EXPORTDATA>
  //     </BODY>
  //   </ENVELOPE>
  // `.trim();

  // try {
  //   const existingXml = await sendToTally(existsXml);
  //   const namePatternAttr = new RegExp(`NAME="${escapeXml(ledger.ledgerName)}"`, 'i');
  //   const namePatternTag  = new RegExp(`<NAME>\\s*${escapeXml(ledger.ledgerName)}\\s*</NAME>`, 'i');
  //   if (namePatternAttr.test(existingXml) || namePatternTag.test(existingXml)) {
  //     logger.info('Ledger already exists in Tally, skipping', { ledgerName: ledger.ledgerName });
  //     return { skipped: true, ledgerName: ledger.ledgerName };
  //   }
  // } catch (checkError) {
  //   // If dedup check fails, proceed with creation anyway
  //   logger.warn('Ledger dedup check failed, proceeding with create', { message: checkError.message });
  // }

  // Dedup check — fetch only this specific ledger by name (lightweight, won't freeze Tally)
  try {
    const existing = await getLedgerByName(ledger.ledgerName);
    if (existing) {
      logger.info('Ledger already exists in Tally, skipping', { ledgerName: ledger.ledgerName });
      return { skipped: true, ledgerName: ledger.ledgerName };
    }
  } catch (checkError) {
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
              <IMPORTDUPS>@@DUPCOMBINE</IMPORTDUPS>
            </STATICVARIABLES>
          </REQUESTDESC>
          <REQUESTDATA>
            <TALLYMESSAGE xmlns:UDF="TallyUDF">
              <LEDGER NAME="${escapeXml(ledger.ledgerName)}" ACTION="Create">
                <NAME>${escapeXml(ledger.ledgerName)}</NAME>
                <PARENT>${escapeXml(ledger.groupName)}</PARENT>
                <OPENINGBALANCE>${ledger.openingBalance || ''}</OPENINGBALANCE>
              </LEDGER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  const importResult = (response || '').match(/<LINEERROR>(.*?)<\/LINEERROR>|<CREATED>(.*?)<\/CREATED>|<ALTERED>(.*?)<\/ALTERED>/i);
  logger.info('Ledger created in Tally', { ledgerName: ledger.ledgerName, tallyResult: importResult ? importResult[0] : 'no error tag found' });
  return response;
}

// Alter (update) an existing Ledger in Tally — used when Bitrix24 contact/company is updated
async function alterLedger(ledger) {
  logger.info('Altering ledger in Tally', { ledgerName: ledger.ledgerName });

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
              <LEDGER NAME="${escapeXml(ledger.ledgerName)}" ACTION="Alter">
                <NAME>${escapeXml(ledger.ledgerName)}</NAME>
                <PARENT>${escapeXml(ledger.groupName)}</PARENT>
              </LEDGER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  logger.info('Ledger altered in Tally', { ledgerName: ledger.ledgerName });
  return response;
}

// Get all Ledgers from Tally
async function getLedgers() {
  // With 16,760 ledgers, fetching all at once freezes Tally.
  // Only fetch ledgers modified/created in the last 7 days.
  // This keeps the XML response tiny and Tally responsive.
  const toDate   = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  logger.info(`Fetching ledgers modified in last 7 days (${fmt(fromDate)} to ${fmt(toDate)})`);

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
              <GROUPNAME>Sundry Debtors</GROUPNAME>
              <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
              <SVTODATE>${fmt(toDate)}</SVTODATE>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  const ledgers  = parseLedgersXml(response);
  logger.info(`Fetched ${ledgers.length} recently modified ledgers`);
  return ledgers;
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
      //const syncGroups = ['sundry debtors', 'sundry creditors'];
      const syncGroups = ['sundry debtors'];
      if (!syncGroups.includes(parent.toLowerCase())) continue;

      ledgers.push({
        ledgerName: name,
        groupName:  parent,
        phone:      get('LEDPHONE')    || get('PHONE')    || '',
        email:      get('LEDEMAIL')    || get('EMAIL')    || '',
        gstin:      get('PARTYGSTIN') || get('GSTIN') || '',
        gstType:    get('GSTREGISTRATIONTYPE') || '',
      });
    }

    logger.info(`Parsed ${ledgers.length} ledgers from Tally`);
    return ledgers;

  } catch (err) {
    logger.error('Failed to parse Tally ledgers XML', { message: err.message });
    return [];
  }
}

// Create Voucher in Tally (Sales Order / Sales Invoice)
async function createVoucher(voucher) {
  logger.info('Creating voucher in Tally', { voucherNumber: voucher.voucherNumber });

  // Build inventory entries — Tally requires these for Sales Order and Sales vouchers.
  // If no line items came from Bitrix, create a single generic service entry.
  const items = (voucher.items && voucher.items.length > 0)
    ? voucher.items
    : [{ name: 'Service', quantity: 1, rate: voucher.amount, amount: voucher.amount }];

  const inventoryXml = items.map(item => `
              <ALLINVENTORYENTRIES.LIST>
                <STOCKITEMNAME>${escapeXml(item.name || 'Service')}</STOCKITEMNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <RATE>${parseFloat(item.rate || 0)}</RATE>
                <AMOUNT>${parseFloat(item.amount || 0)}</AMOUNT>
                <BILLEDQTY>${parseFloat(item.quantity || 1)} Nos</BILLEDQTY>
                <ACTUALQTY>${parseFloat(item.quantity || 1)} Nos</ACTUALQTY>
              </ALLINVENTORYENTRIES.LIST>`).join('');

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
                <ISORDER>Yes</ISORDER>
                <PERSISTEDVIEW>Order Voucher View</PERSISTEDVIEW>
                <VOUCHERNUMBER>BX-${voucher.voucherNumber}</VOUCHERNUMBER>
                <REFERENCE>BX-${voucher.voucherNumber}</REFERENCE>
                <PARTYLEDGERNAME>${escapeXml(voucher.partyName)}</PARTYLEDGERNAME>
                <NARRATION>${escapeXml(voucher.narration)}</NARRATION>
                ${inventoryXml}
                <ALLLEDGERENTRIES.LIST>
                  <LEDGERNAME>${escapeXml(voucher.partyName)}</LEDGERNAME>
                  <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                  <AMOUNT>-${parseFloat(voucher.amount)}</AMOUNT>
                </ALLLEDGERENTRIES.LIST>
              </VOUCHER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);

  // Tally returns HTTP 200 even on failure — check XML body for actual errors
  if (response && response.includes('<LINEERROR>')) {
    const errMatch = response.match(/<LINEERROR>(.*?)<\/LINEERROR>/i);
    const errMsg = errMatch ? errMatch[1] : 'Unknown Tally error';
    logger.error('Tally rejected voucher', { voucherNumber: voucher.voucherNumber, error: errMsg });
    throw new Error(`Tally rejected voucher: ${errMsg}`);
  }

  logger.info('Voucher created in Tally', { voucherNumber: voucher.voucherNumber });
  return response;
}

// Get Outstanding Bills from Tally and parse XML into structured array
async function getOutstanding() {
  logger.info('Fetching outstanding bills from Tally');

  // No date filter — Bills Receivable only returns currently UNPAID bills by design.
  // Tally removes a bill from this report the moment payment is received.
  // So this will never dump 16k records — it only returns genuinely outstanding bills.
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
  const tallyError = detectTallyError(response);
  if (tallyError) {
    logger.error('Tally returned an error for outstanding bills', { error: tallyError });
    return [];
  }
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

function detectTallyError(xml) {
  if (!xml) return 'Empty response from Tally';
  if (xml.includes('<LINEERROR>')) {
    const m = xml.match(/<LINEERROR>(.*?)<\/LINEERROR>/i);
    return m ? m[1] : 'Unknown Tally error';
  }
  if (xml.includes('Company not loaded')) return 'Tally company not loaded — open the correct company in Tally';
  return null;
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

// Fetch a single ledger by exact name — lightweight, won't freeze Tally
async function getLedgerByName(ledgerName) {
  logger.info('Fetching single ledger from Tally', { ledgerName });

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
              <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  try {
    const response = await sendToTally(xml);
    const ledgers  = parseLedgersXml(response);
    return ledgers.find(l => l.ledgerName.toLowerCase() === ledgerName.toLowerCase()) || null;
  } catch (err) {
    logger.warn('Single ledger fetch failed', { ledgerName, message: err.message });
    return null;
  }
}

module.exports = {
  createLedger,
  alterLedger,
  getLedgers,
  getLedgerByName,
  parseLedgersXml,
  createVoucher,
  getOutstanding,
  parseOutstandingXml
};