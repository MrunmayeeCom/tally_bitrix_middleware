const { getStockItems, fetchAllBitrixProducts } = require('./inventoryProcessor');
const { callBitrix } = require('../connectors/bitrixConnector');
const logger = require('../utils/logger');
const fs   = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/inventory-match-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {}
  return { lastRun: null, discrepancies: [] };
}

function saveCache(data) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[InventoryMatcher] Cache save failed: ' + e.message);
  }
}

// Full inventory match — compares Tally vs Bitrix24 item by item
async function runInventoryMatch() {
  try {
    logger.info('[InventoryMatcher] Starting inventory match');

    const [tallyItems, bitrixProducts] = await Promise.all([
      getStockItems(),
      fetchAllBitrixProducts(),
    ]);

    const discrepancies = [];
    const onlyInTally   = [];
    const onlyInBitrix  = [];

    const bitrixMap = {};
    bitrixProducts.forEach(p => {
      bitrixMap[(p.NAME || '').toLowerCase()] = p;
    });

    const tallyMap = {};
    tallyItems.forEach(i => {
      tallyMap[i.name.toLowerCase()] = i;
    });

    // Items in Tally — check against Bitrix24
    for (const item of tallyItems) {
      const key           = item.name.toLowerCase();
      const bitrixProduct = bitrixMap[key];

      if (!bitrixProduct) {
        onlyInTally.push({ name: item.name, tallyQty: item.closingBalance, tallyRate: item.closingRate });
        continue;
      }

      const tallyQty  = item.closingBalance || 0;
      const bitrixQty = parseFloat(bitrixProduct.QUANTITY) || 0;
      const tallyRate = item.closingRate    || 0;
      const bitrixRate= parseFloat(bitrixProduct.PRICE)    || 0;

      const qtyMismatch  = Math.abs(tallyQty  - bitrixQty)  > 0.01;
      const rateMismatch = Math.abs(tallyRate - bitrixRate) > 0.01;

      if (qtyMismatch || rateMismatch) {
        discrepancies.push({
          name:       item.name,
          productId:  bitrixProduct.ID,
          tallyQty,
          bitrixQty,
          qtyDiff:    parseFloat((tallyQty - bitrixQty).toFixed(2)),
          tallyRate,
          bitrixRate,
          rateDiff:   parseFloat((tallyRate - bitrixRate).toFixed(2)),
          qtyMismatch,
          rateMismatch,
        });
      }
    }

    // Items in Bitrix24 but not in Tally
    for (const product of bitrixProducts) {
      const key = (product.NAME || '').toLowerCase();
      if (!tallyMap[key]) {
        onlyInBitrix.push({
          name:      product.NAME,
          productId: product.ID,
          bitrixQty: parseFloat(product.QUANTITY) || 0,
          bitrixRate:parseFloat(product.PRICE)    || 0,
        });
      }
    }

    const result = {
      lastRun:      new Date().toISOString(),
      totalTally:   tallyItems.length,
      totalBitrix:  bitrixProducts.length,
      matched:      tallyItems.length - discrepancies.length - onlyInTally.length,
      discrepancies,
      onlyInTally,
      onlyInBitrix,
    };

    saveCache(result);

    logger.info('[InventoryMatcher] Match completed', {
      discrepancies: discrepancies.length,
      onlyInTally:   onlyInTally.length,
      onlyInBitrix:  onlyInBitrix.length,
    });

    return result;

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[InventoryMatcher] Skipped — Tally offline');
      return loadCache(); // return last known result
    }
    logger.error('[InventoryMatcher] Failed', { message: error.message });
    throw error;
  }
}

// Return cached result without re-running
function getLastMatchResult() {
  return loadCache();
}

// Auto-fix: push Tally quantity/rate to Bitrix24 for mismatched items
async function autoFixDiscrepancies(discrepancies) {
  let fixed  = 0;
  let failed = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (const item of discrepancies) {
    try {
      await callBitrix('crm.product.update', {
        id:     item.productId,
        fields: {
          PRICE:    item.tallyRate,
          QUANTITY: item.tallyQty,
        },
      });
      logger.info('[InventoryMatcher] Auto-fixed discrepancy', { name: item.name });
      fixed++;
      await sleep(300);
    } catch (e) {
      logger.error('[InventoryMatcher] Auto-fix failed', { name: item.name, message: e.message });
      failed++;
    }
  }

  return { fixed, failed };
}

module.exports = { runInventoryMatch, getLastMatchResult, autoFixDiscrepancies };