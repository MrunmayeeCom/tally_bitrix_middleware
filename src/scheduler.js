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
let schedulerStarted = false;

async function runSync(label, fn) {
  if (isSyncing) {
    logger.warn(`Sync already running — skipping ${label}`);
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

// Run ledger sync first, then outstanding sync sequentially
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

  // 11:00 PM — full sync (ledger first, then outstanding)
  cron.schedule('0 23 * * *', () => {
    runFullSync('11PM');
  }, { timezone: 'Asia/Kolkata' });

  // 9:30 AM — due date automation (runs after 9AM sync finishes)
  cron.schedule('30 9 * * *', () => {
    runSync('Due date automation', processDueDates);
  }, { timezone: 'Asia/Kolkata' });

  // Every 4 hours — full sync (gentle on Tally, not every 2 hours)
  cron.schedule('0 */4 * * *', () => {
    runFullSync('4hr');
  }, { timezone: 'Asia/Kolkata' });

  logger.info('Scheduler started — Full sync (ledger → outstanding) at 9AM, 11PM & every 4hrs IST | Due date check at 9:30AM IST');
}

module.exports = { startScheduler };