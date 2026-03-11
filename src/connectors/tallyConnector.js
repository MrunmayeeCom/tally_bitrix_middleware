const axios = require('axios');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

const tallyClient = axios.create({
  baseURL: `http://${tallyConfig.host}:${tallyConfig.port}`,
  headers: { 'Content-Type': 'text/xml' }
});

async function sendToTally(xml) {
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
}

module.exports = { sendToTally };