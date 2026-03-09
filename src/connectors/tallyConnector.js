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
    logger.error('Tally API error', { message: error.message });
    throw error;
  }
}

module.exports = { sendToTally };