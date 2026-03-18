/**
 * LMS Integration Service
 * Calls the License Management System to validate license by customer email.
 *
 * LMS Base URL : https://lisence-system-1.onrender.com
 * Public route : GET /api/public-license/active-license/:email  (no auth needed)
 * Heartbeat    : POST /api/heartbeat/:licenseId
 * External key : x-api-key: my-secret-key-123  (for customer-sync routes only)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const logger = require('../utils/logger');

const LMS_BASE_URL          = process.env.LMS_BASE_URL || 'https://lisence-system-1.onrender.com';
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const LICENSE_CACHE_PATH    = path.join(__dirname, '../../logs/license-cache.json');

let APP_VERSION = '1.0.0';
try { APP_VERSION = require('../../package.json').version || '1.0.0'; } catch {}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function lmsFetch(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url   = new URL(LMS_BASE_URL + endpoint);
    const lib   = url.protocol === 'https:' ? https : http;
    const body  = options.body ? JSON.stringify(options.body) : undefined;

    const reqOptions = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('LMS request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function saveLicenseCache(info) {
  try {
    const dir = path.dirname(LICENSE_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LICENSE_CACHE_PATH, JSON.stringify({ ...info, cachedAt: new Date().toISOString() }));
  } catch (e) { logger.warn(`[LMS] Cache save failed: ${e.message}`); }
}

function loadLicenseCache() {
  try {
    if (fs.existsSync(LICENSE_CACHE_PATH))
      return JSON.parse(fs.readFileSync(LICENSE_CACHE_PATH, 'utf8'));
  } catch {}
  return null;
}

function isCacheFresh(cache) {
  if (!cache?.cachedAt) return false;
  return (Date.now() - new Date(cache.cachedAt).getTime()) < 48 * 60 * 60 * 1000;
}

// ── Feature parser ────────────────────────────────────────────────────────────
// Maps LMS LicenseType.features keys → scheduler feature flags
// Admin sets these keys in the LMS dashboard per plan.
//
// Expected LMS feature keys:
//   syncInterval   (number, minutes)   → 5 / 15 / 60
//   outstandingSync (bool)             → true for all plans
//   ledgerSync      (bool)             → Professional+
//   dueDateSync     (bool)             → Business+
//   maxCompanies    (number)           → 1 or 3

function parseFeatures(raw = {}) {
  const bool = (v) => v === true || v === 'true' || v === 1;
  const num  = (v, fb) => (v !== undefined && !isNaN(Number(v))) ? Number(v) : fb;
  return {
    syncIntervalMinutes: num(raw.syncInterval, 60),
    outstandingSync:     bool(raw.outstandingSync ?? true),
    ledgerSync:          bool(raw.ledgerSync     ?? false),
    dueDateSync:         bool(raw.dueDateSync    ?? false),
    maxCompanies:        num(raw.maxCompanies, 1),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

let _heartbeatTimer    = null;
let _currentLicenseId  = null;

/**
 * Validate license for the given customer email.
 * Uses: GET /api/public-license/active-license/:email  (no auth)
 * Returns: { valid, plan, features, licenseId, endDate, ... }
 */
async function validateLicense(customerEmail) {
  if (!customerEmail) return { valid: false, reason: 'No customer email configured' };

  try {
    logger.info(`[LMS] Validating license for ${customerEmail}`);
    const { status, data } = await lmsFetch(
      `/api/public-license/active-license/${encodeURIComponent(customerEmail)}`
    );

    if (status !== 200 || !data?.license) {
      const cache = loadLicenseCache();
      if (cache && isCacheFresh(cache) && cache.customerEmail === customerEmail) {
        logger.warn('[LMS] Unreachable — using cached license (48h grace)');
        return { ...cache, fromCache: true };
      }
      return { valid: false, reason: data?.message || `HTTP ${status}` };
    }

    const license    = data.license;
    const licType    = license.licenseTypeId || {};
    const rawFeatures = licType.features || license.features || {};

    const result = {
      valid         : license.status === 'active',
      licenseId     : license._id,
      licenseKey    : license.licenseKey,
      plan          : licType.name || 'Unknown',
      status        : license.status,
      endDate       : license.endDate,
      features      : parseFeatures(rawFeatures),
      customerEmail,
    };

    if (result.valid) {
      saveLicenseCache(result);
      _currentLicenseId = result.licenseId;
      logger.info(`[LMS] License valid — Plan: ${result.plan}, expires: ${new Date(result.endDate).toLocaleDateString('en-IN')}`);
    } else {
      logger.warn(`[LMS] License status: "${license.status}"`);
    }

    return result;

  } catch (err) {
    logger.error(`[LMS] validateLicense error: ${err.message}`);
    const cache = loadLicenseCache();
    if (cache && isCacheFresh(cache) && cache.customerEmail === customerEmail) {
      logger.warn('[LMS] Network error — using cached license (48h grace)');
      return { ...cache, fromCache: true };
    }
    return { valid: false, reason: err.message };
  }
}

/**
 * POST /api/heartbeat/:licenseId
 * Keeps the license ACTIVE in LMS. Non-fatal if it fails.
 */
async function sendHeartbeat(licenseId) {
  const id = licenseId || _currentLicenseId;
  if (!id) return;
  try {
    const { status } = await lmsFetch(`/api/heartbeat/${id}`, {
      method: 'POST',
      body: {
        licenseId  : id,
        timestamp  : new Date().toISOString(),
        version    : APP_VERSION,
        usage_data : { app: 'TallyBitrixSync' },
        device_info: { platform: process.platform, nodeVersion: process.version },
      },
    });
    if (status === 200) logger.debug(`[LMS] Heartbeat OK`);
    else logger.warn(`[LMS] Heartbeat HTTP ${status}`);
  } catch (e) {
    logger.warn(`[LMS] Heartbeat failed: ${e.message}`);
  }
}

function startHeartbeat(licenseId) {
  clearHeartbeatInterval();
  _currentLicenseId = licenseId || _currentLicenseId;
  sendHeartbeat(_currentLicenseId);
  _heartbeatTimer = setInterval(() => sendHeartbeat(_currentLicenseId), HEARTBEAT_INTERVAL_MS);
  logger.info('[LMS] Heartbeat loop started (every 30 min)');
}

function clearHeartbeatInterval() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

module.exports = { validateLicense, startHeartbeat, clearHeartbeatInterval, parseFeatures, loadLicenseCache };