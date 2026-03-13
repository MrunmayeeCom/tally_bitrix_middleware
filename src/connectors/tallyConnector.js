const axios = require('axios');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const tallyClient = axios.create({
  baseURL: `http://${tallyConfig.host}:${tallyConfig.port}`,
  headers: { 'Content-Type': 'text/xml' },
  timeout: 120000 // 120 seconds — if Tally doesn't respond, abort instead of hanging
});

async function sendToTally(xml) {
  return withRetry(async () => {
    try {
      logger.info('Sending request to Tally');
      const response = await tallyClient.post('/', xml);
      logger.info('Tally response received');
      return response.data;
    } catch (error) {
      const reason = error.code || error.message || 'unknown';
      const status = error.response?.status || 'no response';
      const body   = error.response?.data   || '';
      logger.error('Tally API error', { code: reason, status, body });
      throw new Error(`Tally unreachable: ${reason}`);
    }
  }, { maxAttempts: 1, delayMs: 3000, label: 'Tally request' });
}

module.exports = { sendToTally };