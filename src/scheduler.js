const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { processTallyToContact } = require('./processors/tallyToContactProcessor');
const { recordSync } = require('./utils/syncHistory');
const logger = require('./utils/logger');

function recordSyncFailure(trigger, message) {
  recordSync({ success: false, processed: 0, failed: 1, trigger, error: message });
}

// ─────────────────────────────────────────
// Scheduler — Runs outstanding sync nightly
// ─────────────────────────────────────────

function startScheduler() {

  // Run every night at 11:00 PM
cron.schedule('0 23 * * *', async () => {
    logger.info('Scheduled outstanding sync triggered');
    try {
      const result = await processOutstanding();
      logger.info('Scheduled sync completed', result);
    } catch (error) {
      logger.error('Scheduled sync failed', { message: error.message });
      recordSyncFailure('11PM scheduled sync', error.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Run every day at 9:00 AM as well
  cron.schedule('0 9 * * *', async () => {
    logger.info('Scheduled outstanding sync triggered');
    try {
      const result = await processOutstanding();
      logger.info('Morning sync completed', result);
    } catch (error) {
      logger.error('Morning sync failed', { message: error.message });
      recordSyncFailure('9AM scheduled sync', error.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Run due date automation daily at 9:30 AM
  cron.schedule('30 9 * * *', async () => {
    logger.info('Scheduled due date automation triggered');
    try {
      await processDueDates();
    } catch (error) {
      logger.error('Due date automation failed', { message: error.message });
      recordSyncFailure('Due date automation', error.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Tally → Bitrix24 ledger sync every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    logger.info('Scheduled Tally → Bitrix24 ledger sync triggered');
    try {
      await processTallyToContact();
    } catch (error) {
      logger.error('Tally → Bitrix24 sync failed', { message: error.message });
      recordSyncFailure('Tally→Bitrix24 ledger sync', error.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Scheduler started — Outstanding sync at 9:00 AM and 11:00 PM IST | Due date check at 9:30 AM IST | Tally→Bitrix24 ledger sync every 2 hours');
}

module.exports = { startScheduler };