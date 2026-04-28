const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');
const { pollInvoices } = require('./processors/invoicePoller');
const featureGate = require('./services/featureGate');
const { processInvoice } = require('./processors/invoiceProcessor');
const { processQuotation } = require('./processors/quotationProcessor');
const { processDeliveryNotes } = require('./processors/deliveryNoteProcessor');

function recordSyncFailure(trigger, message) {
  recordSync({ success: false, processed: 0, failed: 1, trigger, error: message });
}

let isSyncing        = false;
let isDueDateSyncing = false;
let isLedgerSyncing  = false;
let schedulerStarted = false;
let _activeTasks     = []; // track all cron tasks for restart
let isInvoiceSyncing = false;

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

// Add this helper function
async function runInvoiceSync(label) {
  if (isInvoiceSyncing) {
    logger.warn(`Invoice sync already running — skipping ${label}`);
    return;
  }
  isInvoiceSyncing = true;
  try {
    const result = await pollInvoices();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isInvoiceSyncing = false;
  }
}

let isInventorySyncing = false;
let isPaymentSyncing      = false;
let isTallyInvoiceSyncing = false;
let isInventoryMatchRunning = false;
let isReceiptMatchRunning   = false;
let isDeliveryNoteSyncing   = false;

async function runDeliveryNoteSync(label) {
  if (isDeliveryNoteSyncing) {
    logger.warn(`${label} already running — skipping`);
    return;
  }
  isDeliveryNoteSyncing = true;
  try {
    const result = await processDeliveryNotes();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isDeliveryNoteSyncing = false;
  }
}

async function runPaymentSync(label) {
  if (isPaymentSyncing) {
    logger.warn(`Payment sync already running — skipping ${label}`);
    return;
  }
  isPaymentSyncing = true;
  try {
    const { processPayments } = require('./processors/paymentProcessor');
    const result = await processPayments();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isPaymentSyncing = false;
  }
}

async function runInventorySync(label) {
  if (isInventorySyncing) {
    logger.warn(`Inventory sync already running — skipping ${label}`);
    return;
  }
  isInventorySyncing = true;
  try {
    const { processInventory } = require('./processors/inventoryProcessor');
    const result = await processInventory();
    logger.info(`${label} completed`, result || {});
  } catch (error) {
    logger.error(`${label} failed`, { message: error.message });
    recordSyncFailure(label, error.message);
  } finally {
    isInventorySyncing = false;
  }
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

  // Quotation/Delivery Note sync — links to existing deals (Estimates section)
  if (featureGate.isEnabled('quotation-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runDeliveryNoteSync(`${syncMinutes}min — delivery note`);
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Delivery note (quotation) sync registered');
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

  // Invoice polling Bitrix24 → Tally (existing)
  if (featureGate.isEnabled('invoice-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runInvoiceSync(`${syncMinutes}min — invoice poll`);
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Invoice poller registered');
  }

  // Item-based invoice sync (Tally line items → Bitrix24 product rows)
  if (featureGate.isEnabled('invoice-sync')) {
    let isItemInvoiceSyncing = false;
    _activeTasks.push(cron.schedule(syncCron, () => {
      if (isItemInvoiceSyncing) return;
      isItemInvoiceSyncing = true;
      const { processItemInvoices } = require('./processors/itemInvoiceBuilder');
      processItemInvoices()
        .then(r => logger.info(`${syncMinutes}min — item invoice sync completed`, r))
        .catch(e => logger.error('Item invoice sync failed', { message: e.message }))
        .finally(() => { isItemInvoiceSyncing = false; });
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Item-based invoice sync registered');
  }

  // Tally → Bitrix24 invoice sync — offset by 3 minutes from the base interval
  if (featureGate.isEnabled('invoice-sync')) {
    const tallyInvoiceCron = syncMinutes >= 60
      ? '18 * * * *'   // 18 past the hour — never same minute as outstanding (0) or ledger (0)
      : syncMinutes >= 30
      ? '8,38 * * * *'  // offset 8 minutes
      : `3-59/${syncMinutes} * * * *`; // starts 3 min late

    _activeTasks.push(cron.schedule(tallyInvoiceCron, () => {
      if (isTallyInvoiceSyncing) {
        logger.warn('[Scheduler] Tally invoice sync already running — skipping duplicate trigger');
        return;
      }
      isTallyInvoiceSyncing = true;
      const { processTallyInvoices } = require('./processors/tallyInvoiceProcessor');
      processTallyInvoices()
        .then(r => logger.info('Tally invoice sync completed', r))
        .catch(e => logger.error('Tally invoice sync failed', { message: e.message }))
        .finally(() => { isTallyInvoiceSyncing = false; });
    }, { timezone: 'Asia/Kolkata' }));
    logger.info(`[Scheduler] Tally → Bitrix24 invoice sync registered (offset cron: ${tallyInvoiceCron})`);
  }

  // Payment sync — runs on same interval if payment-sync is enabled
  if (featureGate.isEnabled('payment-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runPaymentSync(`${syncMinutes}min — payment sync`);
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Payment sync registered');
  }

  // Inventory sync — runs on same interval if inventory-sync is enabled
  if (featureGate.isEnabled('inventory-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      runInventorySync(`${syncMinutes}min — inventory sync`);
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Inventory sync registered');

    // Bitrix24 → Tally reverse inventory sync — runs every 2 sync cycles to avoid conflicts
    // Starts after a 5-minute delay on startup to avoid flooding logs at boot
    let _bitrixToTallyCycle = 0;
    let _bitrixToTallyReady = false;
    setTimeout(() => { _bitrixToTallyReady = true; }, 5 * 60 * 1000);
    _activeTasks.push(cron.schedule(syncCron, () => {
      if (!_bitrixToTallyReady) return; // skip first few cycles after startup
      _bitrixToTallyCycle++;
      if (_bitrixToTallyCycle % 2 !== 0) return; // run every other cycle
      const { syncBitrixToTally } = require('./processors/inventoryProcessor');
      syncBitrixToTally()
        .then(r => logger.info(`Bitrix→Tally inventory sync completed`, r))
        .catch(e => logger.error('Bitrix→Tally inventory sync failed', { message: e.message }));
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Bitrix24 → Tally reverse inventory sync registered (5min startup delay)');
  }

  // Feature 6: Inventory match — runs every 6 hours
  if (featureGate.isEnabled('inventory-sync')) {
    _activeTasks.push(cron.schedule('0 */6 * * *', () => {
      if (isInventoryMatchRunning) return;
      isInventoryMatchRunning = true;
      const { runInventoryMatch } = require('./processors/inventoryMatcher');
      runInventoryMatch()
        .then(r => logger.info('6hr — inventory match completed', {
          discrepancies: r.discrepancies?.length || 0,
          onlyInTally:   r.onlyInTally?.length   || 0,
        }))
        .catch(e => logger.error('Inventory match failed', { message: e.message }))
        .finally(() => { isInventoryMatchRunning = false; });
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Inventory match registered (every 6hr)');
  }

  // Feature 8: Receipt → Outstanding match — runs on same interval as payment sync
  if (featureGate.isEnabled('payment-sync')) {
    _activeTasks.push(cron.schedule(syncCron, () => {
      if (isReceiptMatchRunning) return;
      isReceiptMatchRunning = true;
      const { matchReceiptsToOutstanding } = require('./processors/outstandingReceiptMatcher');
      matchReceiptsToOutstanding()
        .then(r => logger.info(`${syncMinutes}min — receipt match completed`, {
          matched:   r.matched   || 0,
          unmatched: r.unmatched || 0,
        }))
        .catch(e => logger.error('Receipt match failed', { message: e.message }))
        .finally(() => { isReceiptMatchRunning = false; });
    }, { timezone: 'Asia/Kolkata' }));
    logger.info('[Scheduler] Receipt → Outstanding match registered');
  }

  logger.info(`Scheduler started — outstanding: ${featureGate.isEnabled('outstanding-sync')} | ledger: ${featureGate.isEnabled('contact-sync')} | dueDates: ${featureGate.isEnabled('due-date-automation')} | interval: ${syncMinutes}min`);
}

module.exports = { startScheduler, restartScheduler };