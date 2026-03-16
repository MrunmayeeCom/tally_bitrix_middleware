const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');

function recordSyncFailure(trigger, message) {
  recordSync({ success: false, processed: 0, failed: 1, trigger, error: message });
}

let isSyncing = false;
let isDueDateSyncing = false;
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

// Outstanding-only sync — safe for frequent runs
async function runOutstandingSync(label) {
  await runSync(`${label} — outstanding sync`, processOutstanding);
}

// Full sync — ledger first then outstanding, only for scheduled morning/night runs
async function runFullSync(label) {
  await runSync(`${label} — ledger sync`, processTallyToContact);
  await runSync(`${label} — outstanding sync`, processOutstanding);
}

function startScheduler() {
  if (schedulerStarted) {
    logger.warn('Scheduler already running — skipping duplicate start');
    return;
  }
  schedulerStarted = true;

  // 9:00 AM — full sync (ledger first, then outstanding)
  cron.schedule('0 9 * * *', () => {
    runFullSync('9AM');
  }, { timezone: 'Asia/Kolkata' });

  // 11:00 PM — outstanding only (ledger sync at night is wasteful with 16k ledgers)
  cron.schedule('0 23 * * *', () => {
    runOutstandingSync('11PM');
  }, { timezone: 'Asia/Kolkata' });

  // 9:30 AM — due date automation (runs after 9AM sync finishes)
  cron.schedule('30 9 * * *', () => {
    runDueDateSync('Due date automation', processDueDates);
  }, { timezone: 'Asia/Kolkata' });

  // Every 4 hours during business hours — outstanding bills only, no ledger dump
  cron.schedule('0 8,12,16,20 * * *', () => {
    runOutstandingSync('4hr');
  }, { timezone: 'Asia/Kolkata' });

  logger.info('Scheduler started — Full sync (ledger → outstanding) at 9AM, 11PM & every 4hrs IST | Due date check at 9:30AM IST');
}

module.exports = { startScheduler };