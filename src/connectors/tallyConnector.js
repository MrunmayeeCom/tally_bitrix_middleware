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
  const xml = `<ENVELOPE>
    <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>List of Companies</REPORTNAME>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;

  try {
    const response = await getTallyClient().post('/', xml);
    const raw = response.data || '';
    const matches = [...raw.matchAll(/<BASICCOMPANYNAME[^>]*>(.*?)<\/BASICCOMPANYNAME>/gi)];
    const companies = matches.map(m => m[1].trim()).filter(Boolean);
    return { success: true, companies };
  } catch(e) {
    return { success: false, error: e.message, companies: [] };
  }
}

module.exports = { sendToTally, getTallyClient, getCompanyList };