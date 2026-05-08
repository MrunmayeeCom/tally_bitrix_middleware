const axios = require('axios');
const bitrixConfig = require('../config/bitrixConfig');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const OAuthToken = (() => {
  try {
    // Try to load from render-server models if available (remote mode)
    return require('../../render-server/models/OAuthToken');
  } catch {
    return null;
  }
})();

const bitrixClient = axios.create({
  baseURL: bitrixConfig.webhookUrl,
  headers: { 'Content-Type': 'application/json' }
});

async function getOAuthClient() {
  try {
    const domain = process.env.BITRIX_DOMAIN;
    if (!domain) return null;
    const OAuthToken = require('../models/OAuthToken');
    const token = await OAuthToken.findOne({ bitrixDomain: domain });
    if (!token) return null;
    // Refresh if expiring within 5 minutes
    if (token.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
      const axios = require('axios');
      const res = await axios.post('https://oauth.bitrix.info/oauth/token/', null, {
        params: {
          grant_type: 'refresh_token',
          client_id: process.env.BITRIX_CLIENT_ID,
          client_secret: process.env.BITRIX_CLIENT_SECRET,
          refresh_token: token.refreshToken,
        },
        timeout: 10000,
      });
      token.accessToken = res.data.access_token;
      token.refreshToken = res.data.refresh_token;
      token.expiresAt = new Date(Date.now() + res.data.expires_in * 1000);
      await token.save();
    }
    return axios.create({
      baseURL: `https://${domain}/rest/`,
      headers: { 'Content-Type': 'application/json' },
      params: { auth: token.accessToken }
    });
  } catch (e) {
    return null;
  }
}

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
      const oauthClient = await getOAuthClient();
      const client = oauthClient || bitrixClient;
      const response = await client.post(`/${method}.json`, params);

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
      if (status === 401 || status === 400 || status === 404 || status === 403) {
        error._noRetry = true;
      }
      logger.error(`Bitrix24 API error: ${method}`, { message: error.message });
      throw error;
    }
  }, { maxAttempts: isWrite ? 1 : 3, delayMs: 3000, label: `Bitrix24 ${method}` });
}

module.exports = { callBitrix };