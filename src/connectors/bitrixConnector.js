const axios = require('axios');
const bitrixConfig = require('../config/bitrixConfig');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const bitrixClient = axios.create({
  baseURL: bitrixConfig.webhookUrl,
  headers: { 'Content-Type': 'application/json' }
});

async function callBitrix(method, params = {}) {
  const isWrite = /\.(add|create)$/i.test(method);
  return withRetry(async () => {
    try {
      logger.info(`Bitrix24 API call: ${method}`, params);
      const response = await bitrixClient.post(`/${method}.json`, params);
      logger.info(`Bitrix24 API response: ${method}`, response.data);
      return response.data;
    } catch (error) {
      logger.error(`Bitrix24 API error: ${method}`, { message: error.message });
      throw error;
    }
  }, { maxAttempts: isWrite ? 1 : 3, delayMs: 1500, label: `Bitrix24 ${method}` });
}

module.exports = { callBitrix };