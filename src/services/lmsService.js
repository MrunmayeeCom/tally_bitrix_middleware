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

const LMS_BASE_URL            = process.env.LMS_BASE_URL || 'https://license-system-v6ht.onrender.com';
const LMS_API_KEY             = process.env.LMS_API_KEY  || 'my-secret-key-123';
const PRODUCT_ID              = '69ba90211cf0356ba779b317';
const HEARTBEAT_INTERVAL_MS   = 30 * 60 * 1000; // 30 minutes
const LICENSE_CACHE_PATH      = path.join(__dirname, '../../logs/license-cache.json');
const REGISTRY_CACHE_PATH     = path.join(__dirname, '../../logs/feature-registry-cache.json');
const USAGE_CACHE_PATH        = path.join(__dirname, '../../logs/usage-cache.json');

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
        'x-api-key':    LMS_API_KEY,          
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

// Force clear registry cache so fresh features are fetched
function clearRegistryCache() {
  try {
    const fs   = require('fs');
    if (fs.existsSync(REGISTRY_CACHE_PATH)) fs.unlinkSync(REGISTRY_CACHE_PATH);
    if (fs.existsSync(LICENSE_CACHE_PATH))  fs.unlinkSync(LICENSE_CACHE_PATH);
    logger.info('[LMS] Cache cleared — will re-fetch from LMS on next validation');
  } catch(e) { logger.warn('[LMS] Cache clear failed: ' + e.message); }
}

// ── Feature Registry cache ────────────────────────────────────────────────────
function saveRegistryCache(data) {
  try {
    const dir = path.dirname(REGISTRY_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_CACHE_PATH, JSON.stringify({
      data,
      cachedAt: Date.now()
    }));
  } catch(e) { logger.warn('[LMS] Registry cache save failed: ' + e.message); }
}

function loadRegistryCache() {
  try {
    if (fs.existsSync(REGISTRY_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_CACHE_PATH, 'utf8'));
      // Registry cache valid for 24 hours
      if (raw?.cachedAt && (Date.now() - raw.cachedAt) < 24 * 60 * 60 * 1000) {
        return raw.data;
      }
    }
  } catch {}
  return null;
}

function saveUsageCache(data) {
  try {
    const dir = path.dirname(USAGE_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(data));
  } catch {}
}

function loadUsageCache() {
  try {
    if (fs.existsSync(USAGE_CACHE_PATH))
      return JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
  } catch {}
  return { companyCount: 0 };
}

// Called on startup — syncs local cache to match what LMS actually has
// Prevents any drift from previous sessions
function syncUsageCacheFromLMS(lmsCompanyUsage) {
  const count = Number(lmsCompanyUsage) || 0;
  saveUsageCache({ companyCount: count });
  logger.info(`[LMS] Usage cache synced from LMS — companyCount: ${count}`);
}

// ── Fetch feature registry from LMS ──────────────────────────────────────────
// GET /api/feature-registry/:productId  (requires x-api-key)
// Returns all feature slugs, types and descriptions for this product
async function fetchFeatureRegistry() {
  // Try cache first
  const cached = loadRegistryCache();
  if (cached) {
    logger.info('[LMS] Feature registry loaded from cache');
    return cached;
  }

  try {
    logger.info('[LMS] Fetching feature registry from LMS...');
    const { status, data } = await lmsFetch(
      `/api/feature-registry/${PRODUCT_ID}`,
      { headers: { 'x-api-key': LMS_API_KEY } }
    );

    if (status !== 200) {
      logger.warn(`[LMS] Feature registry fetch failed — HTTP ${status}`);
      return null;
    }

    // Handle both response shapes from LMS
    // Shape A: { success: true, data: { productId, features: [...] } }
    // Shape B: { success: true, features: [...] }
    const registry = data.data || data;
    if (!registry?.features || !Array.isArray(registry.features)) {
      logger.warn('[LMS] Feature registry response has no features array — response: ' + JSON.stringify(data).substring(0, 200));
      return null;
    }

    saveRegistryCache(registry);
    logger.info(`[LMS] Feature registry fetched — ${registry.features.length} features for product ${PRODUCT_ID}`);
    return registry;
  } catch(err) {
    logger.warn('[LMS] Feature registry fetch error: ' + err.message);
    return null;
  }
}

// ── Feature parser ────────────────────────────────────────────────────────────
// Maps LMS LicenseType.features keys → scheduler feature flags
// Admin sets these keys in the LMS dashboard per plan.
//
// Expected LMS feature keys:
//   syncInterval   (number, minutes)   → 5 / 15 / 60
//   outstandingSync (bool)             → true for all plans
//   ledgerSync      (bool)             → Custom+
//   dueDateSync     (bool)             → Custom+
//   maxCompanies    (number)           → 1 or 3

// LMS returns license features as array: [{ featureSlug, featureType, value }]
// Registry provides the master list of all possible slugs + their types
// We merge both: registry defines what exists, license defines what's enabled
function parseFeatures(featuresArray = [], registry = null) {
  if (!Array.isArray(featuresArray)) return featuresArray;

  const map = {};

  // Step 1 — seed all known slugs from registry with disabled defaults
  // This ensures every slug exists in the map even if not in the license
  if (registry?.features && Array.isArray(registry.features)) {
    for (const regFeature of registry.features) {
      const slug = regFeature.featureSlug;
      if (!slug) continue;
      if (regFeature.featureType === 'limit') {
        map[slug] = 0; // default limit = 0
      } else {
        map[slug] = false; // default boolean = false
      }
    }
  }

  // Step 2 — overlay actual license values on top of registry defaults
  for (const f of featuresArray) {
    const slug = f.featureSlug;
    if (!slug) continue;
    if (f.featureType === 'boolean') {
      map[slug] = f.value === true || f.value === 'true' || f.value === 1;
    } else if (f.featureType === 'limit') {
      map[slug] = Number(f.value) || 0;
    } else {
      map[slug] = f.value;
    }
  }

  return map;
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
    // Clear stale cache if it has wrong feature values (one-time fix)
    const staleCache = loadLicenseCache();
    if (staleCache && staleCache.features && 
        staleCache.features['contact-sync'] === false &&
        staleCache.customerEmail === customerEmail) {
      logger.info('[LMS] Stale cache detected — clearing to re-fetch correct features');
      clearRegistryCache();
    }

    // Step 1 — fetch feature registry first (dynamic, cached 24h)
    const registry = await fetchFeatureRegistry();

    logger.info(`[LMS] Validating license for ${customerEmail}`);

    // Step 2 — fetch active license for this email + product
    const { status, data } = await lmsFetch(
      `/api/external/actve-license/${encodeURIComponent(customerEmail)}?productId=${PRODUCT_ID}`,
      { headers: { 'x-api-key': LMS_API_KEY } }
    );

    // LMS returns activeLicense (not license)
    const license = data.activeLicense || data.license;

    if (status !== 200 || !license) {
      const cache = loadLicenseCache();
      if (cache && isCacheFresh(cache) && cache.customerEmail === customerEmail) {
        logger.warn('[LMS] Unreachable — using cached license (48h grace)');
        return { ...cache, fromCache: true };
      }
      return { valid: false, reason: data?.message || `HTTP ${status}` };
    }

    const licType     = license.licenseTypeId || {};
    // Features are directly on activeLicense.features as array
    // and also on licenseTypeId.features — prefer the direct one as it has values
    const rawFeatures = license.features || licType.features || [];

    // Step 3 — merge registry defaults + license values into flat slug map
    const features = parseFeatures(rawFeatures, registry);

    // Extract current company usage from LMS response
    // Try multiple possible response locations
    const lmsCompanyUsage = license.usageStats?.['company-limit']
                         ?? license.usage?.['company-limit']
                         ?? license.currentUsage?.companyCount
                         ?? null;

    const result = {
      valid         : license.status === 'active',
      licenseId     : license._id,
      licenseKey    : license.licenseKey,
      userId        : license.userId || license.user?._id || license._id, // store for heartbeat
      plan          : licType.name || 'Unknown',
      status        : license.status,
      endDate       : license.endDate,
      features,
      registry,
      customerEmail,
      lmsCompanyUsage,
    };

    if (result.valid) {
      saveLicenseCache(result);
      _currentLicenseId = result.licenseId;
      logger.info(`[LMS] License valid — Plan: ${result.plan} | expires: ${new Date(result.endDate).toLocaleDateString('en-IN')} | features: ${Object.keys(features).length}`);

      // Log which features are enabled for this plan
      const enabled = Object.entries(features)
        .filter(([, v]) => v === true || (typeof v === 'number' && v > 0))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      logger.info(`[LMS] Enabled features: ${enabled}`);
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
async function sendHeartbeat(licenseId, usageFeatures = []) {
  const id = licenseId || _currentLicenseId;
  if (!id) return;

  // Get userId from license cache — LMS expects the user's _id, not licenseId
  const cache = loadLicenseCache();
  const userId = cache?.userId || cache?.licenseId || id;

  try {
    const { status } = await lmsFetch(`/api/heartbeat/${id}`, {
      method: 'POST',
      body: {
        userId,
        features: usageFeatures, // [{ slug, value }]
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
  sendHeartbeat(_currentLicenseId, []);
  _heartbeatTimer = setInterval(() => sendHeartbeat(_currentLicenseId, []), HEARTBEAT_INTERVAL_MS);
  logger.info('[LMS] Heartbeat loop started (every 30 min)');
}

/**
 * Update company-limit usage in LMS via heartbeat
 * value = number of companies currently configured
 * LMS increments usage, so we send the delta (not absolute count)
 */
async function updateCompanyUsage(newCount) {
  const id = _currentLicenseId;
  if (!id) {
    logger.warn('[LMS] Cannot update company usage — no active licenseId');
    return;
  }

  const usage      = loadUsageCache();
  const prevCount  = usage.companyCount || 0;
  const delta      = newCount - prevCount;

  if (delta === 0) {
    logger.info(`[LMS] company-limit unchanged (${newCount}) — skipping`);
    return;
  }

  const cache  = loadLicenseCache();
  const userId = cache?.licenseId || id;

  try {
    logger.info(`[LMS] Updating company-limit — prev: ${prevCount}, new: ${newCount}, delta: ${delta > 0 ? '+' : ''}${delta}`);
    
    // Save cache BEFORE the API call so rapid sequential calls
    // read the updated count and don't recalculate wrong deltas
    saveUsageCache({ companyCount: newCount });

    const { status } = await lmsFetch(`/api/heartbeat/${id}`, {
      method: 'POST',
      body: {
        userId,
        features: [{ slug: 'company-limit', value: delta }]
      }
    });
    if (status === 200) {
      logger.info(`[LMS] company-limit updated: ${prevCount} → ${newCount}`);
    } else {
      // Revert cache if LMS call failed
      saveUsageCache({ companyCount: prevCount });
      logger.warn(`[LMS] company-limit update failed — HTTP ${status}, reverted cache`);
    }
  } catch(e) {
    // Revert cache on error
    saveUsageCache({ companyCount: prevCount });
    logger.warn(`[LMS] updateCompanyUsage error: ${e.message}`);
  }
}

function clearHeartbeatInterval() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// ── Periodic re-validation ────────────────────────────────────────────────────
let _revalidateTimer = null;

function startRevalidation(customerEmail, onResult) {
  if (_revalidateTimer) clearInterval(_revalidateTimer);
  _revalidateTimer = setInterval(async () => {
    logger.info('[LMS] Periodic re-validation...');
    const result = await validateLicense(customerEmail);
    onResult(result);
  }, 6 * 60 * 60 * 1000); // every 6 hours
}

function stopRevalidation() {
  if (_revalidateTimer) { clearInterval(_revalidateTimer); _revalidateTimer = null; }
}

module.exports = { validateLicense, fetchFeatureRegistry, startHeartbeat, startRevalidation, stopRevalidation, clearHeartbeatInterval, parseFeatures, loadLicenseCache, loadUsageCache, saveUsageCache, syncUsageCacheFromLMS, clearRegistryCache, updateCompanyUsage };
