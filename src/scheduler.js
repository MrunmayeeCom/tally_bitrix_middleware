const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');

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

function startScheduler() {
  if (schedulerStarted) {
    logger.warn('Scheduler already running — skipping duplicate start');
    return;
  }
  schedulerStarted = true;

  // 9:00 AM — full sync (ledger first, then outstanding) as daily baseline
  cron.schedule('0 9 * * *', () => {
    runFullSync('9AM');
  }, { timezone: 'Asia/Kolkata' });

  // Every 15 minutes — outstanding bills sync
  cron.schedule('*/15 * * * *', () => {
    runOutstandingSync('15min');
  }, { timezone: 'Asia/Kolkata' });

  // Every 5 minutes — Tally → Bitrix24 ledger sync (own lock, never blocked by other syncs)
  cron.schedule('*/5 * * * *', () => {
    runLedgerSync('5min — ledger sync', () => processTallyToContact({ manual: true }));
  }, { timezone: 'Asia/Kolkata' });

  // Every 1 hour — due date automation
  cron.schedule('0 * * * *', () => {
    runDueDateSync('1hr — due date automation', processDueDates);
  }, { timezone: 'Asia/Kolkata' });

  logger.info('Scheduler started — Full sync at 9AM daily | Outstanding sync every 15min | Ledger sync every 5min | Due date automation every 1hr IST');
}

module.exports = { startScheduler };