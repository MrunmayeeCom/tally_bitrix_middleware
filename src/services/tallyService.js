const { sendToTally } = require('../connectors/tallyConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

const MOCK_MODE = false; // Real Tally licensed version

// Create Ledger in Tally (skips if ledger already exists)
async function createLedger(ledger) {
  logger.info('Creating ledger in Tally', { ledgerName: ledger.ledgerName });

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

    const ledgerRegex = /<LEDGER\b[^>]*>([\s\S]*?)<\/LEDGER>/gi;
    let match;

    while ((match = ledgerRegex.exec(xml)) !== null) {
      const block = match[1];

      const get = (tag) => {
        const m = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      const nameAttr = /NAME="([^"]+)"/i.exec(match[0]);
      const name     = get('NAME') || (nameAttr ? nameAttr[1].trim() : '');
      const parent   = get('PARENT');

      if (!name) continue;

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
                <VOUCHERNUMBER>BX-${voucher.voucherNumber}</VOUCHERNUMBER>
                <REFERENCE>BX-${voucher.voucherNumber}</REFERENCE>
                <PARTYLEDGERNAME>${escapeXml(voucher.partyName)}</PARTYLEDGERNAME>
                <NARRATION>${escapeXml(voucher.narration)}</NARRATION>
                <ALLLEDGERENTRIES.LIST>
                  <LEDGERNAME>${escapeXml(voucher.partyName)}</LEDGERNAME>
                  <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                  <AMOUNT>-${parseFloat(voucher.amount)}</AMOUNT>
                </ALLLEDGERENTRIES.LIST>
                <ALLLEDGERENTRIES.LIST>
                  <LEDGERNAME>Sales</LEDGERNAME>
                  <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                  <AMOUNT>${parseFloat(voucher.amount)}</AMOUNT>
                </ALLLEDGERENTRIES.LIST>
                ${(voucher.productRows && voucher.productRows.length > 0)
                  ? voucher.productRows.map(row => {
                      const name = row.PRODUCT_NAME || row.productName || '';
                      const price = parseFloat(row.PRICE || row.price || 0);
                      const qty = parseFloat(row.QUANTITY || row.quantity || 1);
                      const amount = (price * qty).toFixed(2);
                      return `
                <ALLINVENTORYENTRIES.LIST>
                  <STOCKITEMNAME>${escapeXml(name)}</STOCKITEMNAME>
                  <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                  <RATE>${price}</RATE>
                  <AMOUNT>-${amount}</AMOUNT>
                  <ACTUALQTY>${qty} Nos</ACTUALQTY>
                  <BILLEDQTY>${qty} Nos</BILLEDQTY>
                </ALLINVENTORYENTRIES.LIST>`;
                    }).join('\n')
                  : ''}
              </VOUCHER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  logger.info('Raw Tally voucher XML being sent', { voucherNumber: voucher.voucherNumber, xml });
  const response = await sendToTally(xml);
  logger.info('Raw Tally voucher response', {
    voucherNumber: voucher.voucherNumber,
    response: (response || '').substring(0, 800)
  });

  if (response && response.includes('<LINEERROR>')) {
    const errMatch = response.match(/<LINEERROR>(.*?)<\/LINEERROR>/i);
    const errMsg = errMatch ? errMatch[1] : 'Unknown Tally error';
    logger.error('Tally rejected voucher', { voucherNumber: voucher.voucherNumber, error: errMsg });
    throw new Error(`Tally rejected voucher: ${errMsg}`);
  }

  const created    = parseInt((response || '').match(/<CREATED>(\d+)<\/CREATED>/i)?.[1] ?? '0');
  const exceptions = parseInt((response || '').match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/i)?.[1] ?? '0');
  const errors     = parseInt((response || '').match(/<ERRORS>(\d+)<\/ERRORS>/i)?.[1] ?? '0');
  const altered    = parseInt((response || '').match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1] ?? '0');

  if (exceptions > 0 || errors > 0) {
    if (voucher.voucherType === 'Sales Order') {
      logger.warn('Sales Order rejected by Tally — retrying as Sales Invoice', { voucherNumber: voucher.voucherNumber });
      return createVoucher({ ...voucher, voucherType: 'Sales' });
    }
    logger.error('Tally voucher create failed', { voucherNumber: voucher.voucherNumber, created, exceptions, errors });
    throw new Error(`Tally voucher create failed (created=${created}, exceptions=${exceptions}, errors=${errors})`);
  }

  if (created === 0 && altered === 0) {
    logger.error('Tally silently ignored voucher — voucher type name may not exist in Tally', {
      voucherNumber: voucher.voucherNumber,
      voucherType:   voucher.voucherType,
      hint:          'Go to Gateway of Tally → Accounts Info → Voucher Types and confirm the exact name'
    });
    throw new Error(`Tally ignored voucher (CREATED=0, no errors) — voucher type "${voucher.voucherType}" may not exist in Tally`);
  }

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

    const billRegex = /<BILLFIXED>([\s\S]*?)<\/BILLFIXED>\s*<BILLCL>(.*?)<\/BILLCL>\s*<BILLDUE>(.*?)<\/BILLDUE>\s*<BILLOVERDUE>(.*?)<\/BILLOVERDUE>/gi;
    let match;

    while ((match = billRegex.exec(xml)) !== null) {
      const block       = match[1];
      const billCl      = match[2].trim();
      const billDue     = match[3].trim();
      const billOverdue = match[4].trim();

      const get = (tag) => {
        const m = new RegExp(`<${tag}>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      const partyName     = get('BILLPARTY');
      const voucherNumber = get('BILLREF');
      const billDateRaw   = get('BILLDATE');
      const amount        = Math.abs(parseFloat(billCl)) || 0;

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

// Convert Tally display date "1-Apr-25" or "1-Apr-2025" → YYYYMMDD
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
  // Decode ALL levels of HTML entity encoding first (handles double/triple encoding)
  let decoded = str;
  let prev = '';
  while (prev !== decoded) {
    prev = decoded;
    decoded = decoded
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#13;/g,  '')
      .replace(/&#10;/g,  ' ')
      .replace(/&#9;/g,   ' ');
  }
  // Strip any remaining control characters (CR, LF, TAB, etc.)
  decoded = decoded.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return decoded
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

async function alterVoucher(voucher) {
  logger.info('Updating voucher via delete+recreate', { voucherNumber: voucher.voucherNumber });

  const voucherTypeName = voucher.voucherType || 'Sales';
  const voucherDate = voucher.date
    ? voucher.date.replace(/-/g, '')
    : new Date().toISOString().slice(0, 10).replace(/-/g, '');

  logger.info('Resolved voucher metadata', { voucherNumber: voucher.voucherNumber, voucherTypeName, voucherDate });

  // ── Step 1: Resolve MASTERID via Day Book scan ────────────────────────────
  let masterId = voucher.masterId || null;
  if (!masterId) {
    logger.info('No MASTERID provided — scanning Day Book', { voucherNumber: voucher.voucherNumber });
    masterId = await findMasterId(
      `BX-${voucher.voucherNumber}`,
      voucherTypeName,
      tallyConfig,
      sendToTally,
      escapeXml,
    );
  }

  if (!masterId) {
    logger.warn('Voucher not found in Tally — creating fresh', { voucherNumber: voucher.voucherNumber });
    return _createAndCache(voucher, voucherTypeName, null);
  }

  // ── Step 2: Fetch the exact DATE Tally recorded for this MASTERID ─────────
  // Tally delete requires the exact original DATE — sending today's date fails
  let tallyRecordedDate = voucherDate;
  try {
    const today    = new Date();
    const fromDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
    const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    const scanXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Day Book</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
          <SVTODATE>${fmt(today)}</SVTODATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`.trim();
    const scanResp = await sendToTally(scanXml);
    // Find the voucher block with this exact MASTERID
    const voucherBlockRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
    let vBlock;
    while ((vBlock = voucherBlockRegex.exec(scanResp)) !== null) {
      const attrs = vBlock[1];
      const block = vBlock[2];
      const attrMid = (attrs.match(/MASTERID="(\d+)"/i)?.[1] || '').trim();
      const innerMid = (block.match(/<MASTERID>\s*(\d+)\s*<\/MASTERID>/i)?.[1] || '').trim();
      if (attrMid === String(masterId) || innerMid === String(masterId)) {
        const dateM = block.match(/<DATE>\s*(\d{8})\s*<\/DATE>/i);
        if (dateM) {
          tallyRecordedDate = dateM[1];
          logger.info('Fetched exact Tally DATE for delete', { masterId, tallyRecordedDate });
        }
        break;
      }
    }
  } catch (scanErr) {
    logger.warn('Could not fetch Tally DATE — using voucher date as fallback', { message: scanErr.message });
  }

  // ── Step 3: Delete the old voucher by MASTERID ────────────────────────────
  logger.info('Deleting old voucher', { voucherNumber: voucher.voucherNumber, masterId, tallyRecordedDate });

  const deleteXml = `
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
          <VOUCHER VCHTYPE="${voucherTypeName}" ACTION="Delete" MASTERID="${masterId}">
            <DATE>${tallyRecordedDate}</DATE>
            <MASTERID>${masterId}</MASTERID>
            <VOUCHERTYPENAME>${voucherTypeName}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>BX-${voucher.voucherNumber}</VOUCHERNUMBER>
            <REFERENCE>BX-${voucher.voucherNumber}</REFERENCE>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

  const deleteResp = await sendToTally(deleteXml);
  const deleted    = parseInt((deleteResp || '').match(/<DELETED>(\d+)<\/DELETED>/i)?.[1] ?? '0');
  const delAltered = parseInt((deleteResp || '').match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1]  ?? '0');

  logger.info('Delete response', {
    voucherNumber: voucher.voucherNumber, masterId, deleted, delAltered,
    response: (deleteResp || '').substring(0, 300),
  });

  if (deleted !== 1 && delAltered !== 1) {
    const errMsg = (deleteResp || '').match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] || 'DELETED != 1';
    logger.warn('Delete failed — creating fresh without deleting old', {
      voucherNumber: voucher.voucherNumber, masterId, error: errMsg,
    });
    // Don't abort — still create the updated voucher so Bitrix data is reflected
    return _createAndCache(voucher, voucherTypeName, masterId);
  }

  logger.info('Voucher deleted successfully', { voucherNumber: voucher.voucherNumber, masterId });

  // ── Step 4: Recreate with updated values ──────────────────────────────────
  return _createAndCache(voucher, voucherTypeName, masterId);
}

async function _createAndCache(voucher, voucherTypeName, oldMasterId) {
  const resp = await createVoucher(voucher);
  try {
    const { storeMasterId } = require('../utils/voucherCache');
    const midMatch = (resp || '').match(/<LASTVCHID>\s*([1-9]\d*)\s*<\/LASTVCHID>/i);
    const newMid   = midMatch?.[1] || null;
    if (newMid && voucher.entityId) {
      storeMasterId(voucher.entityId, newMid, `BX-${voucher.voucherNumber}`, voucherTypeName, {
        version:   1,
        amount:    voucher.amount,
        partyName: voucher.partyName,
      });
      logger.info('Cache updated after create', {
        voucherNumber: voucher.voucherNumber, oldMasterId, newMasterId: newMid,
      });
    }
  } catch (e) {
    logger.warn('Cache update failed — non-fatal', { message: e.message });
  }
  return resp;
}

// Shared helper: create voucher and store new MASTERID in cache
async function _createAndCache(voucher, voucherTypeName, oldMasterId) {
  const resp = await createVoucher(voucher);
  try {
    const { storeMasterId } = require('../utils/voucherCache');
    const midMatch = (resp || '').match(/<LASTVCHID>\s*([1-9]\d*)\s*<\/LASTVCHID>/i);
    const newMid   = midMatch?.[1] || null;
    if (newMid && voucher.entityId) {
      storeMasterId(voucher.entityId, newMid, `BX-${voucher.voucherNumber}`, voucherTypeName, {
        version:   1,
        amount:    voucher.amount,
        partyName: voucher.partyName,
      });
      logger.info('Cache updated after create', {
        voucherNumber: voucher.voucherNumber, oldMasterId, newMasterId: newMid,
      });
    }
  } catch (e) {
    logger.warn('Cache update failed after create — non-fatal', { message: e.message });
  }
  return resp;
}

async function findMasterId(voucherNumber, voucherTypeName, tallyConfig, sendToTally, escapeXml) {
  const logger = require('../utils/logger');
  const today    = new Date();
  const fromDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const fetchXml = `
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Day Book</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
          <SVTODATE>${fmt(today)}</SVTODATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`.trim();

  const response = await sendToTally(fetchXml);

  const voucherBlockRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
  let vBlock;
  let lastMatch = null;
  while ((vBlock = voucherBlockRegex.exec(response)) !== null) {
    const attrs    = vBlock[1];
    const block    = vBlock[2];
    const numM     = block.match(/<VOUCHERNUMBER[^>]*>(.*?)<\/VOUCHERNUMBER>/i);
    const refM     = block.match(/<REFERENCE[^>]*>(.*?)<\/REFERENCE>/i);
    const billRefM = block.match(/<BILLALLOCATIONS\.LIST>[\s\S]*?<NAME>(.*?)<\/NAME>/i);
    const idM      = block.match(/<MASTERID>\s*([1-9]\d*)\s*<\/MASTERID>/i);
    const attrMidM = attrs.match(/MASTERID="(\d+)"/i);

    if (!idM && !attrMidM) continue;
    const resolvedMasterId = idM?.[1] || attrMidM?.[1];

    // Skip cancelled vouchers — they cannot be deleted and should not be targeted
    const isCancelled = /ISCANCELLED\s*=\s*"Yes"/i.test(attrs) ||
                        /<ISCANCELLED>\s*Yes\s*<\/ISCANCELLED>/i.test(vBlock[2]);
    if (isCancelled) continue;

    const vNum       = (numM?.[1] || '').trim();
    const vRef       = (refM?.[1] || '').trim();
    const vBillRef   = (billRefM?.[1] || '').trim();
    const attrVchNum = (attrs.match(/VOUCHERNUMBER="([^"]+)"/i)?.[1] || '').trim();

    if (vNum === voucherNumber || vRef === voucherNumber || vBillRef === voucherNumber || attrVchNum === voucherNumber) {
      lastMatch = {
        masterId: resolvedMasterId,
        matchedOn: vNum === voucherNumber ? 'VOUCHERNUMBER'
                 : vRef === voucherNumber ? 'REFERENCE'
                 : attrVchNum === voucherNumber ? 'ATTR_VOUCHERNUMBER'
                 : 'BILLALLOCATIONS',
      };
    }
  }

  if (lastMatch) {
    logger.info('Found MASTERID via Day Book scan (last match — most recent active voucher)', {
      voucherNumber,
      masterId: lastMatch.masterId,
      matchedOn: lastMatch.matchedOn,
    });
    return lastMatch.masterId;
  }
  return null;
}

// Delete a voucher in Tally by voucher number
async function deleteVoucher(voucherNumber) {
  logger.info('Deleting voucher in Tally', { voucherNumber });

  const today    = new Date();
  const fromDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const fetchXml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>Day Book</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>
              <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
              <SVTODATE>${fmt(today)}</SVTODATE>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>`.trim();

  let masterId    = null;
  let voucherDate = null;
  try {
    const fetchResponse     = await sendToTally(fetchXml);
    const voucherBlockRegex = /<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
    let vBlock;
    while ((vBlock = voucherBlockRegex.exec(fetchResponse)) !== null) {
      const block    = vBlock[1];
      const numMatch = block.match(/<VOUCHERNUMBER[^>]*>(.*?)<\/VOUCHERNUMBER>/i);
      const refMatch = block.match(/<REFERENCE[^>]*>(.*?)<\/REFERENCE>/i);
      const idMatch  = block.match(/<MASTERID>\s*(\d+)\s*<\/MASTERID>/i);
      const vNum     = (numMatch && numMatch[1].trim()) || '';
      const vRef     = (refMatch && refMatch[1].trim()) || '';
      if (idMatch) logger.info('Scanning voucher block', { vNum, vRef, masterId: idMatch[1] });
      if (idMatch && (vNum === voucherNumber || vRef === voucherNumber)) {
        masterId = idMatch[1];
        const dateMatch = block.match(/<DATE>\s*(\d+)\s*<\/DATE>/i);
        voucherDate = dateMatch ? dateMatch[1].trim() : null;
        logger.info('Found voucher MASTERID for delete', { voucherNumber, masterId, voucherDate });
        break;
      }
    }
    if (!masterId) logger.warn('MASTERID not found in Day Book', { voucherNumber });
  } catch (fetchErr) {
    logger.warn('Could not fetch voucher MASTERID', { message: fetchErr.message });
  }

  if (!masterId) {
    logger.warn('No MASTERID found — skipping delete', { voucherNumber });
    return null;
  }

  const deleteXml = `
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
              <VOUCHER VCHTYPE="Sales Order" ACTION="Delete" MASTERID="${masterId}">
                <DATE>${voucherDate || new Date().toISOString().slice(0,10).replace(/-/g,'')}</DATE>
                <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>
                <VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>
                <REFERENCE>${escapeXml(voucherNumber)}</REFERENCE>
                <MASTERID>${masterId}</MASTERID>
                <PERSISTEDVIEW>Sales Order Voucher View</PERSISTEDVIEW>
              </VOUCHER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>`.trim();

  const response = await sendToTally(deleteXml);
  logger.info('Raw Tally delete response', { voucherNumber, masterId, response: (response || '').substring(0, 300) });

  if (response && response.includes('<DELETED>1</DELETED>')) {
    logger.info('Voucher successfully deleted from Tally', { voucherNumber, masterId });
    return response;
  }
  if (response && response.includes('Cannot delete unnamed object')) {
    logger.warn('Tally could not delete voucher (unnamed object) — proceeding anyway', { voucherNumber, masterId });
    return null;
  }

  logger.error('Voucher delete failed', { voucherNumber, masterId });
  throw new Error(`Voucher delete failed for ${voucherNumber} — will not recreate to avoid duplicate`);
}

async function getVoucherTypes() {
  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>List of Voucher Types</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>`.trim();

  try {
    const response = await sendToTally(xml);
    const names = [];
    const regex = /<VOUCHERTYPE\b[^>]*>([\s\S]*?)<\/VOUCHERTYPE>/gi;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const nameMatch = match[1].match(/<NAME>(.*?)<\/NAME>/i);
      const nameAttr  = /NAME="([^"]+)"/i.exec(match[0]);
      const name = (nameMatch && nameMatch[1].trim()) || (nameAttr && nameAttr[1].trim()) || '';
      if (name) names.push(name);
    }
    logger.info('Fetched voucher types from Tally', { count: names.length, names });
    return names;
  } catch (err) {
    logger.warn('Could not fetch voucher types from Tally', { message: err.message });
    return [];
  }
}

async function ensureTallyDefaults() {
  logger.info('Ensuring Tally default masters exist');
  const xml = `
    <ENVELOPE>
      <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
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
              <LEDGER NAME="Sales" ACTION="Create">
                <NAME>Sales</NAME>
                <PARENT>Sales Accounts</PARENT>
              </LEDGER>
            </TALLYMESSAGE>
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>
    </ENVELOPE>`.trim();
  try {
    const response = await sendToTally(xml);
    logger.info('Tally defaults ensured', { response: (response || '').substring(0, 200) });
  } catch (e) {
    logger.warn('Could not ensure Tally defaults', { message: e.message });
  }
}

module.exports = {
  createLedger,
  alterLedger,
  getLedgers,
  getLedgerByName,
  parseLedgersXml,
  createVoucher,
  alterVoucher,
  deleteVoucher,
  getOutstanding,
  parseOutstandingXml,
  ensureTallyDefaults,
  getVoucherTypes,
  findMasterId,
};