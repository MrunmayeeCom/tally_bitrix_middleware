const express = require('express');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/healthRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const { processOutstanding } = require('./processors/outstandingProcessor');
const { processDueDates } = require('./processors/dueDateProcessor');
const { authMiddleware } = require('./middleware/authMiddleware');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// routes
app.use('/health', healthRoutes);
app.use('/webhook', webhookRoutes);

// manual outstanding sync trigger — protected by API key in production
app.post('/sync/outstanding', authMiddleware, async (req, res) => {
  try {
    logger.info('Manual outstanding sync triggered');
    const result = await processOutstanding();
    result.trigger = 'manual';
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    const offline = error.message === 'TALLY_OFFLINE';
    logger.warn('Manual outstanding sync failed', { message: error.message });
    res.status(offline ? 503 : 500).json({
      success: false,
      message: offline ? 'Tally is not running. Please open Tally and try again.' : error.message
    });
  }
});

// manual Tally → Bitrix24 ledger sync trigger
// NOTE: Disabled for large companies (16k+ ledgers) — causes Tally freeze
// Ledger sync only runs at 9AM scheduled job
app.post('/sync/tally-to-bitrix', authMiddleware, async (req, res) => {
  try {
    const { processTallyToContact } = require('./processors/tallyToContactProcessor');
    logger.info('Manual ledger sync triggered');
    const result = await processTallyToContact({ manual: true });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('Manual ledger sync failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// manual due date automation trigger
app.post('/sync/duedates', authMiddleware, async (req, res) => {
  try {
    logger.info('Manual due date automation triggered');
    await processDueDates();
    res.status(200).json({ success: true, message: 'Due date automation completed' });
  } catch (error) {
    logger.error('Manual due date automation failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// sync history endpoint
app.get('/sync/history', authMiddleware, (req, res) => {
  const { getSyncHistory, getLastSync } = require('./utils/syncHistory');
  res.json({
    lastSync: getLastSync(),
    history:  getSyncHistory(20)
  });
});

const path = require("path");

app.use(express.static(path.join(__dirname, "../agent/installer")));

app.all("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../agent/installer/index.html"));
});

// error handler — must be last
app.use(errorHandler);

module.exports = app;