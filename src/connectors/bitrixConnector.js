const axios = require('axios');
const bitrixConfig = require('../config/bitrixConfig');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const bitrixClient = axios.create({
  baseURL: bitrixConfig.webhookUrl,
  headers: { 'Content-Type': 'application/json' }
});

// Methods whose full response is too large to log usefully
const VERBOSE_RESPONSE_METHODS = [
  'crm.company.get',
  'crm.contact.get',
  'crm.item.get',
  'crm.deal.get',
  'crm.category.list',
  'crm.dealcategory.stage.list',
  'crm.status.list'
];

async function callBitrix(method, params = {}) {
  const isWrite = /\.(add|create|set|delete)$/i.test(method);
  return withRetry(async () => {
    try {
      logger.info(`Bitrix24 API call: ${method}`, params);
      const response = await bitrixClient.post(`/${method}.json`, params);

      // Avoid logging huge response bodies for get/list methods
      if (VERBOSE_RESPONSE_METHODS.includes(method)) {
        const result = response.data?.result;
        const id = result?.ID || result?.id || result?.item?.id || '—';
        const title = result?.TITLE || result?.NAME || result?.item?.title || '—';
        logger.info(`Bitrix24 API response: ${method}`, { id, title });
      } else {
        logger.info(`Bitrix24 API response: ${method}`, response.data);
      }

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      if (status === 502 || status === 503 || status === 429) {
        logger.warn(`Bitrix24 rate limit / overload (${status}) on ${method} — waiting 5s before retry`);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (status === 401 || status === 400 || status === 404) {
        error._noRetry = true;
      }
      logger.error(`Bitrix24 API error: ${method}`, { message: error.message });
      throw error;
    }
  }, { maxAttempts: isWrite ? 1 : 3, delayMs: 3000, label: `Bitrix24 ${method}` });
}

module.exports = { callBitrix };