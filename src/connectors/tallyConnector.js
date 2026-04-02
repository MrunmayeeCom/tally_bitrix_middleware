const axios = require('axios');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

// Do NOT cache tallyClient — create fresh on each request
// so host/port changes are picked up immediately
function getTallyClient() {
  return axios.create({
    baseURL: `http://${tallyConfig.host}:${tallyConfig.port}`,
    headers: { 'Content-Type': 'text/xml' },
    timeout: 8000
  });
}

async function sendToTally(xml) {
  // Pre-check: is Tally port even open? Fast 3s TCP check before sending heavy XML
  const net = require('net');
  const isPortOpen = await new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.on('connect', () => { sock.destroy(); resolve(true);  });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(parseInt(tallyConfig.port), tallyConfig.host);
  });

  if (!isPortOpen) {
    logger.warn('Tally port not open — skipping sync', { host: tallyConfig.host, port: tallyConfig.port });
    throw new Error('TALLY_OFFLINE');
  }

  return withRetry(async () => {
    try {
      logger.info('Sending request to Tally');
      const response = await getTallyClient().post('/', xml);
      logger.info('Tally response received');
      return response.data;
    } catch (error) {
      const reason = error.code || error.message || 'unknown';
      const status = error.response?.status || 'no response';
      const body   = error.response?.data   || '';

      if (reason === 'ECONNABORTED' || reason === 'ECONNREFUSED' || reason === 'ETIMEDOUT') {
        logger.warn('Tally is not running — skipping sync', { code: reason });
        throw new Error('TALLY_OFFLINE');
      }

      logger.error('Tally API error', { code: reason, status, body });
      throw new Error(`Tally unreachable: ${reason}`);
    }
  }, { maxAttempts: 1, delayMs: 3000, label: 'Tally request', silent: true });
}

async function getCompanyList() {
  const xmlVariants = [
    // Variant 1 — Correct TallyPrime Collection API (per official docs TYPE=Collection)
    `<ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>List of Companies</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="List of Companies" ISMODIFY="Yes">
                <TYPE>Company</TYPE>
                <NATIVEMETHOD>Name</NATIVEMETHOD>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>`,

    // Variant 2 — Export Data style with SVCURRENTCOMPANY wildcard
    `<ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Data</TYPE>
        <ID>List of Accounts</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            <AccountType>Companies</AccountType>
          </STATICVARIABLES>
        </DESC>
      </BODY>
    </ENVELOPE>`,

    // Variant 3 — TDL inline report (most compatible across Silver/Gold/Server)
    `<ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Data</TYPE>
        <ID>MyCompanyList</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <REPORT NAME="MyCompanyList">
                <FORMS>MyCompanyList</FORMS>
              </REPORT>
              <FORM NAME="MyCompanyList">
                <TOPPARTS>MyCompanyList</TOPPARTS>
                <XMLTAG>MyCompanyList</XMLTAG>
              </FORM>
              <PART NAME="MyCompanyList">
                <TOPLINES>MyCompanyList</TOPLINES>
                <REPEAT>MyCompanyList : MyCompanyColl</REPEAT>
                <SCROLLED>Vertical</SCROLLED>
              </PART>
              <LINE NAME="MyCompanyList">
                <LEFTFIELDS>MyCompanyName</LEFTFIELDS>
                <XMLTAG>COMPANY</XMLTAG>
              </LINE>
              <FIELD NAME="MyCompanyName">
                <SET>$Name</SET>
                <XMLTAG>NAME</XMLTAG>
              </FIELD>
              <COLLECTION NAME="MyCompanyColl">
                <TYPE>Company</TYPE>
                <NATIVEMETHOD>Name</NATIVEMETHOD>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>`,

    // Variant 4 — Object export for currently loaded company (fallback for Silver single-company)
    `<ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Object</TYPE>
        <SUBTYPE>Company</SUBTYPE>
        <ID TYPE="Name">##SVCurrentCompany</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
          <FETCHLIST>
            <FETCH>Name</FETCH>
          </FETCHLIST>
        </DESC>
      </BODY>
    </ENVELOPE>`
  ];

  // Try each XML variant until one works
  for (const xml of xmlVariants) {
    try {
      const response = await getTallyClient().post('/', xml);
      const raw = response.data || '';

      logger.info('[Tally] Raw company list response (first 500 chars):', raw.substring(0, 500));

      // Skip if Tally returned a LINEERROR for this report name
      if (raw.includes('<LINEERROR>')) {
        logger.warn('[Tally] Report not found — trying next variant');
        continue;
      }

      let companies = [];

      // Try 1 — BASICCOMPANYNAME (Tally ERP 9)
      const match1 = [...raw.matchAll(/<BASICCOMPANYNAME[^>]*>(.*?)<\/BASICCOMPANYNAME>/gi)];
      if (match1.length > 0) {
        companies = match1.map(m => m[1].trim()).filter(Boolean);
        logger.info('[Tally] Companies found via BASICCOMPANYNAME:', companies);
      }

      // Try 2 — CMPSTKNAME (TallyPrime some versions)
      if (companies.length === 0) {
        const match2 = [...raw.matchAll(/<CMPSTKNAME[^>]*>(.*?)<\/CMPSTKNAME>/gi)];
        companies = match2.map(m => m[1].trim()).filter(Boolean);
        if (companies.length > 0)
          logger.info('[Tally] Companies found via CMPSTKNAME:', companies);
      }

      // Try 3 — NAME inside COMPANY block (TDL response)
      if (companies.length === 0) {
        const match3 = [...raw.matchAll(/<COMPANY[^>]*>[\s\S]*?<NAME>(.*?)<\/NAME>[\s\S]*?<\/COMPANY>/gi)];
        companies = match3.map(m => m[1].trim()).filter(Boolean);
        if (companies.length > 0)
          logger.info('[Tally] Companies found via COMPANY/NAME block:', companies);
      }

      // Try 4 — COMPANY tag with NAME child (TDL collection response)
      if (companies.length === 0) {
        const match4 = [...raw.matchAll(/<COMPANY[^>]*>\s*<NAME>(.*?)<\/NAME>/gi)];
        companies = match4.map(m => m[1].trim()).filter(Boolean);
        if (companies.length > 0)
          logger.info('[Tally] Companies found via COMPANY>NAME block:', companies);
      }

      // Try 5 — bare NAME tags anywhere (Object export / last resort)
      if (companies.length === 0) {
        const match5 = [...raw.matchAll(/<NAME>(.*?)<\/NAME>/gi)];
        // Filter out obviously non-company values (empty, numeric-only, XML artifacts)
        companies = match5
          .map(m => m[1].trim())
          .filter(n => n && n.length > 1 && !/^\d+$/.test(n) && !n.startsWith('$$'));
        if (companies.length > 0)
          logger.info('[Tally] Companies found via NAME tag (last resort):', companies);
      }

      if (companies.length > 0) {
        return { success: true, companies };
      }

      logger.warn('[Tally] No company tags found in this response — trying next variant');

    } catch(e) {
      logger.warn('[Tally] Variant failed:', e.message);
      continue;
    }
  }

  // All variants exhausted
  logger.warn('[Tally] All report variants failed — TallyPrime Silver may restrict company list export');
  return {
    success: false,
    error: 'TallyPrime could not export company list — please use "Add manually" option and type the exact company name as shown in Tally (e.g. "Averlon" or "Test Company")',
    companies: []
  };
}

module.exports = { sendToTally, getTallyClient, getCompanyList };