/**
 * voucherCache.js
 * Persists Tally MASTERID keyed by Bitrix24 entityId.
 * Written at voucher CREATE time, read at UPDATE time.
 * Lives alongside the other log-directory caches (pipeline-cache, sync-history, etc.)
 */

const fs   = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/voucher-masterid-cache.json');

// ── internal helpers ──────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function save(data) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    // non-fatal — worst case we fall back to Day Book scan
    console.warn('[VoucherCache] Save failed:', e.message);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Store a MASTERID for a given Bitrix24 entity after successful Tally creation.
 *
 * @param {string|number} entityId      - Bitrix24 quote/invoice ID
 * @param {string}        masterId      - Tally MASTERID returned after CREATE
 * @param {string}        voucherNumber - The voucher number used (e.g. "BX-42")
 * @param {string}        [voucherType] - e.g. "Sales Order"
 */
function storeMasterId(entityId, masterId, voucherNumber, voucherType = '', extra = {}) {
  const cache = load();
  cache[String(entityId)] = {
    masterId,
    voucherNumber,
    voucherType,
    storedAt: new Date().toISOString(),
    ...extra,
  };
  save(cache);
}

function patchMasterId(entityId, patch = {}) {
  const cache = load();
  const existing = cache[String(entityId)] || {};
  cache[String(entityId)] = { ...existing, ...patch };
  save(cache);
}

/**
 * Retrieve a previously stored MASTERID.
 *
 * @param {string|number} entityId
 * @returns {{ masterId, voucherNumber, voucherType, storedAt } | null}
 */
function getMasterId(entityId) {
  const cache = load();
  return cache[String(entityId)] || null;
}

/**
 * Remove entry — call if a voucher is deleted from Tally
 * so stale IDs never cause a mis-alter.
 *
 * @param {string|number} entityId
 */
function removeMasterId(entityId) {
  const cache = load();
  delete cache[String(entityId)];
  save(cache);
}

module.exports = { storeMasterId, getMasterId, removeMasterId, patchMasterId };