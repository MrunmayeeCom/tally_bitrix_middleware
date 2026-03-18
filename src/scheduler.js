const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');

// Active plan features — set by applySchedulerFeatures() after LMS validation
let _features = null;

/** Called from main.js after validateLicense() succeeds */
function applySchedulerFeatures(features) {
  _features = features;
  logger.info(`[LMS] Scheduler features applied — syncInterval: ${features.syncIntervalMinutes}min | outstanding: ${features.outstandingSync} | ledger: ${features.ledgerSync} | dueDates: ${features.dueDateSync}`);
}

/** Returns current feature map (used by /api/status) */
function getActiveFeatures() { return _features; }

function recordSyncFailure(trigger, message) {
  recordSync({ success: false, processed: 0, failed: 1, trigger, error: message });
}

let isSyncing        = false;
let isDueDateSyncing = false;
let isLedgerSyncing  = false;
let schedulerStarted = false;

async function runSync(label, fn) {
  if (isSyncing) {
    logger.warn(`Sync already running — skipping ${label}`, { skippedAt: new Date().toISOString() });
    return;
  }
  isSyncing = true;
  try {
    const result = await fn();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isSyncing = false;
  }
}

async function runDueDateSync(label, fn) {
  if (isDueDateSyncing) {
    logger.warn(`Due date sync already running — skipping ${label}`);
    return;
  }
  isDueDateSyncing = true;
  try {
    const result = await fn();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isDueDateSyncing = false;
  }
}

// Separate lock for ledger sync — never blocked by due date or outstanding sync
async function runLedgerSync(label, fn) {
  if (isLedgerSyncing) {
    logger.warn(`Ledger sync already running — skipping ${label}`);
    return;
  }
  isLedgerSyncing = true;
  try {
    const result = await fn();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isLedgerSyncing = false;
  }
}

// Outstanding-only sync — safe for frequent runs
async function runOutstandingSync(label) {
  await runSync(`${label} — outstanding sync`, processOutstanding);
}

// Full sync — ledger first then outstanding, only for scheduled morning run
async function runFullSync(label) {
  await runLedgerSync(`${label} — ledger sync`, processTallyToContact);
  await runSync(`${label} — outstanding sync`, processOutstanding);
}

function intervalToCron(minutes) {
  const valid = [5, 15, 30, 60];
  const m = valid.includes(minutes) ? minutes : 60;
  return m < 60 ? `*/${m} * * * *` : `0 * * * *`;
}

function startScheduler() {
  if (schedulerStarted) {
    logger.warn('Scheduler already running — skipping duplicate start');
    return;
  }
  schedulerStarted = true;

  // Resolve feature gates — fallback to Starter limits if LMS not yet validated
  const f = _features || {
    syncIntervalMinutes: 60,
    outstandingSync:     true,
    ledgerSync:          false,
    dueDateSync:         false,
  };

  const syncCron = intervalToCron(f.syncIntervalMinutes);

  // 9:00 AM IST — daily full sync (always runs for all plans)
  cron.schedule('0 9 * * *', () => {
    if (f.ledgerSync)      runLedgerSync('9AM — ledger sync', processTallyToContact);
    if (f.outstandingSync) runOutstandingSync('9AM — outstanding sync');
  }, { timezone: 'Asia/Kolkata' });

  // Outstanding sync — all plans (interval depends on plan)
  if (f.outstandingSync) {
    cron.schedule(syncCron, () => {
      runOutstandingSync(`${f.syncIntervalMinutes}min — outstanding`);
    }, { timezone: 'Asia/Kolkata' });
  }

  // Ledger sync — Professional+ only
  if (f.ledgerSync) {
    cron.schedule(syncCron, () => {
      runLedgerSync(`${f.syncIntervalMinutes}min — ledger sync`, () => processTallyToContact({ manual: true }));
    }, { timezone: 'Asia/Kolkata' });
  }

  // Due date automation — Business+ only
  if (f.dueDateSync) {
    cron.schedule('0 * * * *', () => {
      runDueDateSync('1hr — due date automation', processDueDates);
    }, { timezone: 'Asia/Kolkata' });
  }

  logger.info(`Scheduler started — Plan features: outstandingSync=${f.outstandingSync} | ledgerSync=${f.ledgerSync} | dueDateSync=${f.dueDateSync} | interval=${f.syncIntervalMinutes}min`);
}

module.exports = { startScheduler, applySchedulerFeatures, getActiveFeatures };