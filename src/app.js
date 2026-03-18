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

// dashboard API endpoints — consumed by browser mode (Bitrix24 Agent Dashboard)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST');
  next();
});

app.get('/api/status', (req, res) => {
  const cfg = (() => { try { return require('./config/bitrixConfig'); } catch { return {}; } })();
  res.json({ running: true, config: {
    bitrixUrl:    process.env.BITRIX_WEBHOOK_URL || '',
    tallyHost:    process.env.TALLY_HOST         || 'localhost',
    tallyPort:    process.env.TALLY_PORT         || 9000,
    tallyCompany: process.env.TALLY_COMPANY      || '',
  }});
});

app.get('/api/history', (req, res) => {
  const { getSyncHistory } = require('./utils/syncHistory');
  res.json(getSyncHistory(50));
});

app.get('/api/overdue', async (req, res) => {
  try {
    const { callBitrix } = require('./connectors/bitrixConnector');
    const { getTallyPipelineCategoryId } = require('./services/pipelineService');
    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) return res.json([]);

    // Get overdue stage ID
    const stagesData = await callBitrix('crm.dealcategory.stage.list', { id: categoryId });
    const stages = stagesData.result || [];
    const overdueStage = stages.find(s => (s.NAME||'').toLowerCase() === 'overdue');
    if (!overdueStage) return res.json([]);

    // Fetch all deals in overdue stage
    const data = await callBitrix('crm.deal.list', {
      filter: { CATEGORY_ID: categoryId, STAGE_ID: overdueStage.STATUS_ID },
      select: ['ID','TITLE','OPPORTUNITY','CLOSEDATE','ASSIGNED_BY_ID'],
      start: 0
    });
    const deals = (data.result || []).map(d => ({
      id:       d.ID,
      title:    d.TITLE,
      amount:   parseFloat(d.OPPORTUNITY) || 0,
      dueDate:  d.CLOSEDATE ? d.CLOSEDATE.split('T')[0] : '',
      daysOverdue: d.CLOSEDATE
        ? Math.max(0, Math.floor((Date.now() - new Date(d.CLOSEDATE)) / 86400000))
        : 0
    })).sort((a, b) => b.amount - a.amount);

    res.json(deals);
  } catch(e) {
    res.json([]);
  }
});

app.get('/api/lastsync', (req, res) => {
  const { getLastSync } = require('./utils/syncHistory');
  res.json(getLastSync() || {});
});

app.get('/api/logs', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../logs/combined.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-150).join('\n');
    res.json({ logs: lines });
  } catch {
    res.json({ logs: 'No logs yet.' });
  }
});

app.post('/api/trigger/outstanding', authMiddleware, async (req, res) => {
  const { processOutstanding } = require('./processors/outstandingProcessor');
  res.json({ triggered: true });
  processOutstanding().catch(() => {});
});

app.post('/api/trigger/ledgers', authMiddleware, async (req, res) => {
  const { processTallyToContact } = require('./processors/tallyToContactProcessor');
  res.json({ triggered: true });
  processTallyToContact({ manual: true }).catch(() => {});
});

const path = require("path");

app.use(express.static(path.join(__dirname, "../agent/installer")));
app.use(express.static(path.join(__dirname, "../agent")));

// Bitrix Agent Dashboard — served at /dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../agent/dashboard.html"));
});

app.all("/", (req, res) => {
  // If request comes from a browser (Bitrix iframe), serve the dashboard directly
  const accept = req.headers['accept'] || '';
  const userAgent = req.headers['user-agent'] || '';
  const isBrowser = accept.includes('text/html');
  const isElectron = userAgent.includes('Electron');

  if (isBrowser && !isElectron) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, "../agent/installer/index.html"));
});

// error handler — must be last
app.use(errorHandler);

module.exports = app;