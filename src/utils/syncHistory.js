const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '../../logs/sync-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-100), null, 2));
  } catch {}
}

function recordSync(result) {
  const history = loadHistory();
  history.push({
    timestamp:  new Date().toISOString(),
    processed:  result.processed  || 0,
    failed:     result.failed     || 0,
    success:    result.success    || false,
    trigger:    result.trigger    || 'scheduled',
    error:      result.error      || null
  });
  saveHistory(history);
}

function getLastSync() {
  const history = loadHistory();
  return history.length > 0 ? history[history.length - 1] : null;
}

function getSyncHistory(limit = 20) {
  const history = loadHistory();
  return history.slice(-limit).reverse();
}

module.exports = { recordSync, getLastSync, getSyncHistory };