const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SNAPSHOT_PATH = path.join(__dirname, '../../logs/tally-snapshot.json');

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSnapshot(snapshot) {
  try {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  } catch {}
}

function hashLedger(ledger) {
  const str = `${ledger.ledgerName}|${ledger.phone}|${ledger.email}|${ledger.gstin}|${ledger.gstType}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

function detectChanges(currentLedgers) {
  const snapshot = loadSnapshot();
  const newSnapshot = {};
  const changed = [];
  const added = [];

  for (const ledger of currentLedgers) {
    const hash = hashLedger(ledger);
    newSnapshot[ledger.ledgerName] = hash;

    if (!snapshot[ledger.ledgerName]) {
      added.push(ledger);
      logger.info('New ledger detected in Tally', { ledgerName: ledger.ledgerName });
    } else if (snapshot[ledger.ledgerName] !== hash) {
      changed.push(ledger);
      logger.info('Changed ledger detected in Tally', { ledgerName: ledger.ledgerName });
    }
  }

  saveSnapshot(newSnapshot);

  logger.info('Tally change detection completed', {
    total:   currentLedgers.length,
    added:   added.length,
    changed: changed.length
  });

  return { added, changed };
}

module.exports = { detectChanges, hashLedger };