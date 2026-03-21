const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '../../logs/sync-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch {
    try { fs.renameSync(HISTORY_PATH, HISTORY_PATH + '.corrupted'); } catch {}
  }
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-500), null, 2));
  } catch {}
}

function recordSync(result) {
  const history = loadHistory();

  // Read active company at time of sync
  let company = '';
  try {
    company = require('../config/tallyConfig').company || '';
  } catch {}

  history.push({
    timestamp:  new Date().toISOString(),
    processed:  result.processed  || 0,
    failed:     result.failed     || 0,
    success:    result.success    || false,
    trigger:    result.trigger    || 'scheduled',
    error:      result.error      || null,
    company,                          // ← which company was active during this sync
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

const ESCALATION_COOLDOWN_PATH = path.join(__dirname, '../../logs/escalation-cooldown.json');

function loadEscalationCooldown() {
  try {
    if (fs.existsSync(ESCALATION_COOLDOWN_PATH)) {
      return JSON.parse(fs.readFileSync(ESCALATION_COOLDOWN_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveEscalationCooldown(data) {
  try {
    fs.writeFileSync(ESCALATION_COOLDOWN_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function getEscalationLastSent(dealId) {
  const data = loadEscalationCooldown();
  return data[String(dealId)] || 0;
}

function setEscalationLastSent(dealId, timestamp) {
  const data = loadEscalationCooldown();
  data[String(dealId)] = timestamp;
  saveEscalationCooldown(data);
}

module.exports = { recordSync, getLastSync, getSyncHistory, getEscalationLastSent, setEscalationLastSent };