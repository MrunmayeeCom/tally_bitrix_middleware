const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');
const featureGate = require('./services/featureGate');

function recordSyncFailure(trigger, message) {
  recordSync({ success: false, processed: 0, failed: 1, trigger, error: message });
}

let isSyncing        = false;
let isDueDateSyncing = false;
let isLedgerSyncing  = false;
let schedulerStarted = false;
let _activeTasks     = []; // track all cron tasks for restart

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
  const m = Math.max(1, Math.floor(Number(minutes) || 60));
  if (m >= 60) return `0 * * * *`;
  if (m === 1) return `* * * * *`;
  return `*/${m} * * * *`;
}

function stopScheduler() {
  _activeTasks.forEach(task => { try { task.stop(); } catch {} });
  _activeTasks = [];
  schedulerStarted = false;
  logger.info('[Scheduler] All cron tasks stopped');
}

function restartScheduler() {
  logger.info('[Scheduler] Restarting due to plan change...');
  stopScheduler();
  startScheduler();
}

function startScheduler() {
  if (schedulerStarted) {
    logger.warn('Scheduler already running — skipping duplicate start');
    return;
  }
  schedulerStarted = true;

  // Block scheduler entirely if no active license
  if (!featureGate.isLicenseActive()) {
    logger.warn('[Scheduler] No active license — all scheduled sync is disabled');
    schedulerStarted = false; // allow restart once license activates
    return;
  }

  const syncMinutes = featureGate.getLimit('auto-sync', 0);
  if (!syncMinutes) {
    logger.warn('[Scheduler] auto-sync limit is 0 — no sync interval configured on this plan');
    schedulerStarted = false;
    return;
  }
  const syncCron    = intervalToCron(syncMinutes);

  logger.info(`[Scheduler] Plan: ${featureGate.getPlan()} | interval: ${syncMinutes}min`);

  // 9AM daily — full sync baseline (always runs)
  _activeTasks.push(cron.schedule('0 9 * * *', () => {
    if (featureGate.isEnabled('contact-sync') || featureGate.isEnabled('company-sync')) {
      runLedgerSync('9AM — ledger sync', processTallyToContact);
    }
    if (featureGate.isEnabled('outstanding-sync')) {
      runOutstandingSync('9AM — outstanding sync');
    }
  }, { timezone: 'Asia/Kolkata' }));

  // Outstanding sync — all plans (interval depends on plan)
  if (featureGate.isEnabled('outstanding-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runOutstandingSync(`${syncMinutes}min — outstanding`);
    }, { timezone: 'Asia/Kolkata' }));
  }

  // Ledger sync — Custom+ (contact-sync or company-sync slug enabled)
  if (featureGate.isEnabled('contact-sync') || featureGate.isEnabled('company-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runLedgerSync(`${syncMinutes}min — ledger sync`, () => processTallyToContact({ manual: true }));
    }, { timezone: 'Asia/Kolkata' }));
  }

  // Due date automation — Custom+ only
  if (featureGate.isEnabled('due-date-automation')) {
    _activeTasks.push(cron.schedule('0 * * * *', () => {
      runDueDateSync('1hr — due date automation', processDueDates);
    }, { timezone: 'Asia/Kolkata' }));
  }

  logger.info(`Scheduler started — outstanding: ${featureGate.isEnabled('outstanding-sync')} | ledger: ${featureGate.isEnabled('contact-sync')} | dueDates: ${featureGate.isEnabled('due-date-automation')} | interval: ${syncMinutes}min`);}

module.exports = { startScheduler, restartScheduler };