const cron = require('node-cron');
const { processOutstanding } = require('./processors/outstandingProcessor');
const logger = require('./utils/logger');

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
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Run every day at 9:00 AM as well
  cron.schedule('0 9 * * *', async () => {
    logger.info('Morning outstanding sync triggered');
    try {
      const result = await processOutstanding();
      logger.info('Morning sync completed', result);
    } catch (error) {
      logger.error('Morning sync failed', { message: error.message });
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Scheduler started — Outstanding sync at 9:00 AM and 11:00 PM IST daily');
}

module.exports = { startScheduler };