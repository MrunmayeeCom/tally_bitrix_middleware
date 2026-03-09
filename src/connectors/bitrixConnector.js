const axios = require('axios');
const bitrixConfig = require('../config/bitrixConfig');
const logger = require('../utils/logger');

const bitrixClient = axios.create({
  baseURL: bitrixConfig.webhookUrl,
  headers: { 'Content-Type': 'application/json' }
});

async function callBitrix(method, params = {}) {
  try {
    logger.info(`Bitrix24 API call: ${method}`, params);
    const response = await bitrixClient.post(`/${method}.json`, params);
    logger.info(`Bitrix24 API response: ${method}`, response.data);
    return response.data;
  } catch (error) {
    logger.error(`Bitrix24 API error: ${method}`, { message: error.message });
    throw error;
  }
}

module.exports = { callBitrix };