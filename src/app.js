const express = require('express');
const path    = require('path');
const fs      = require('fs');
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
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('manual-trigger')) {
    return res.status(403).json({ success: false, message: 'manual-trigger not enabled on your plan' });
  }
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
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('manual-trigger')) {
    return res.status(403).json({ success: false, message: 'manual-trigger not enabled on your plan' });
  }
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
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('manual-trigger')) {
    return res.status(403).json({ success: false, message: 'manual-trigger not enabled on your plan' });
  }
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
  const featureGate  = (() => { try { return require('./services/featureGate');  } catch { return null; } })();
  const lmsService   = (() => { try { return require('./services/lmsService');   } catch { return null; } })();
  const licenseCache = lmsService ? lmsService.loadLicenseCache() : null;

  // featureGate may be empty if bootstrapLicense hasn't run yet
  // In that case, fall back to the cached license features directly
  let features = featureGate ? featureGate.getAll() : {};
  const hasFeatures = Object.keys(features).length > 0;

  if (!hasFeatures && licenseCache?.features) {
    // Parse features from cache — already a flat slug map
    features = licenseCache.features;

    // Also seed featureGate so subsequent calls don't need cache fallback
    if (featureGate && typeof featureGate.setFeatures === 'function') {
      featureGate.setFeatures(licenseCache.features, licenseCache.plan);
    }
  }

  res.json({
    running: true,
    license: licenseCache ? {
      plan    : licenseCache.plan,
      status  : licenseCache.status,
      endDate : licenseCache.endDate,
      features,
    } : null,
    config: {
      bitrixUrl:      process.env.BITRIX_WEBHOOK_URL  || '',
      tallyHost:      process.env.TALLY_HOST           || 'localhost',
      tallyPort:      process.env.TALLY_PORT           || 9000,
      tallyCompany:   process.env.TALLY_COMPANY        || '',
      tallyCompanies: (process.env.TALLY_COMPANIES || process.env.TALLY_COMPANY || '').split(',').filter(Boolean),
      activeCompany:  process.env.TALLY_COMPANY        || '',
    }
  });
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

// Payment status for a specific party
app.get('/api/payments/status', authMiddleware, async (req, res) => {
  try {
    const { partyName } = req.query;
    if (!partyName) return res.json({ success: false, message: 'partyName required' });
    const { callBitrix } = require('./connectors/bitrixConnector');
    const { getTallyPipelineCategoryId } = require('./services/pipelineService');
    const categoryId = await getTallyPipelineCategoryId();
    const data = await callBitrix('crm.deal.list', {
      filter: { '%TITLE': partyName, ...(categoryId ? { CATEGORY_ID: categoryId } : {}) },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'UF_PAYMENT_STATUS', 'UF_PAYMENT_DATE', 'UF_PAYMENT_AMOUNT'],
    });
    res.json({ success: true, deals: data.result || [] });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/lastsync', (req, res) => {
  const { getLastSync } = require('./utils/syncHistory');
  res.json(getLastSync() || {});
});

// ── Feature 6: Inventory matching ─────────────────────────────────────────────
app.get('/api/inventory/match', authMiddleware, async (req, res) => {
  try {
    const { getLastMatchResult } = require('./processors/inventoryMatcher');
    res.json({ success: true, ...getLastMatchResult() });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/sync/inventory-match', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('inventory-sync')) {
    return res.status(403).json({ success: false, message: 'inventory-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual inventory match triggered');
    const { runInventoryMatch } = require('./processors/inventoryMatcher');
    const result = await runInventoryMatch();
    res.status(200).json({ success: true, ...result });
  } catch(e) {
    logger.error('Inventory match failed', { message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/sync/inventory-match/fix', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('inventory-sync')) {
    return res.status(403).json({ success: false, message: 'inventory-sync not enabled on your plan' });
  }
  try {
    const { getLastMatchResult, autoFixDiscrepancies } = require('./processors/inventoryMatcher');
    const { discrepancies } = getLastMatchResult();
    if (!discrepancies || discrepancies.length === 0) {
      return res.json({ success: true, fixed: 0, message: 'No discrepancies to fix' });
    }
    const result = await autoFixDiscrepancies(discrepancies);
    res.json({ success: true, ...result });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Feature 7: Item-based invoice — product rows from Tally catalog ───────────
app.get('/api/inventory/products', authMiddleware, async (req, res) => {
  try {
    const { fetchAllBitrixProducts } = require('./processors/inventoryProcessor');
    const products = await fetchAllBitrixProducts();
    res.json({ success: true, count: products.length, products });
  } catch(e) {
    res.json({ success: false, message: e.message, products: [] });
  }
});

// ── Feature 8: Receipt → Outstanding matching ─────────────────────────────────
app.get('/api/receipts/match', authMiddleware, async (req, res) => {
  try {
    const { getLastMatchResult } = require('./processors/outstandingReceiptMatcher');
    res.json({ success: true, ...getLastMatchResult() });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/sync/receipts-match', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('payment-sync')) {
    return res.status(403).json({ success: false, message: 'payment-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual receipt match triggered');
    const { matchReceiptsToOutstanding } = require('./processors/outstandingReceiptMatcher');
    const result = await matchReceiptsToOutstanding();
    res.status(200).json({ success: true, ...result });
  } catch(e) {
    logger.error('Receipt match failed', { message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

// Scan Tally for available companies
app.get('/api/tally/companies', async (req, res) => {
  try {
    const { getCompanyList } = require('./connectors/tallyConnector');
    const result = await getCompanyList();
    res.json(result);
  } catch(e) {
    res.json({ success: false, error: e.message, companies: [] });
  }
});

// Get list of configured companies
app.get('/api/companies', (req, res) => {
  const tallyConfig = require('./config/tallyConfig');
  const companies   = tallyConfig.getCompanies();
  const active      = tallyConfig.company || companies[0] || '';
  res.json({ companies, active });
});

// Update company count in LMS when companies list changes
app.post('/api/companies/update-usage', authMiddleware, async (req, res) => {
  const { count } = req.body;
  try {
    const { updateCompanyUsage } = require('./services/lmsService');
    await updateCompanyUsage(Number(count));
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// Switch active company — writes to config and restarts Tally connector
app.post('/api/companies/switch', authMiddleware, (req, res) => {
  const { company } = req.body;
  const tallyConfig = require('./config/tallyConfig');
  const companies   = tallyConfig.getCompanies();

  if (!companies.includes(company)) {
    return res.status(400).json({ success: false, message: 'Company not in configured list' });
  }

  tallyConfig.setCompany(company);
  logger.info(`Active Tally company switched to: ${company}`);
  res.json({ success: true, active: company });
});

app.get('/api/logs', (req, res) => {
  const logPath = path.join(__dirname, '../logs/combined.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-150).join('\n');
    res.json({ logs: lines });
  } catch {
    res.json({ logs: 'No logs yet.' });
  }
});

app.post('/api/trigger/outstanding', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('manual-trigger')) {
    return res.status(403).json({ success: false, message: 'manual-trigger not enabled on your plan' });
  }
  if (featureGate && !featureGate.isEnabled('outstanding-sync')) {
    return res.status(403).json({ success: false, message: 'outstanding-sync not enabled on your plan' });
  }
  const { processOutstanding } = require('./processors/outstandingProcessor');
  res.json({ triggered: true });
  processOutstanding().catch(() => {});
});

app.post('/api/trigger/ledgers', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('manual-trigger')) {
    return res.status(403).json({ success: false, message: 'manual-trigger not enabled on your plan' });
  }
  if (featureGate && !featureGate.isEnabled('contact-sync') && !featureGate.isEnabled('company-sync')) {
    return res.status(403).json({ success: false, message: 'ledger-sync not enabled on your plan' });
  }
  const { processTallyToContact } = require('./processors/tallyToContactProcessor');
  res.json({ triggered: true });
  processTallyToContact({ manual: true }).catch(() => {});
});

// Inventory mismatch check
app.get('/api/inventory/mismatches', authMiddleware, async (req, res) => {
  try {
    const { getStockItems, fetchAllBitrixProducts, validateClosingStock } = require('./processors/inventoryProcessor');
    const [tallyItems, bitrixProducts] = await Promise.all([getStockItems(), fetchAllBitrixProducts()]);
    const discrepancies = validateClosingStock(tallyItems, bitrixProducts);
    res.json({ success: true, count: discrepancies.length, discrepancies });
  } catch(e) {
    res.json({ success: false, message: e.message, discrepancies: [] });
  }
});

// Tally → Bitrix24 invoice sync trigger
app.post('/sync/tally-invoices', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('invoice-sync')) {
    return res.status(403).json({ success: false, message: 'invoice-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual Tally → Bitrix24 invoice sync triggered');
    const { processTallyInvoices } = require('./processors/tallyInvoiceProcessor');
    const result = await processTallyInvoices();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('Tally invoice sync failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// Historical Tally → Bitrix24 invoice backfill (2016 → now, runs async, non-blocking)
app.post('/sync/tally-invoices/backfill', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('invoice-sync')) {
    return res.status(403).json({ success: false, message: 'invoice-sync not enabled on your plan' });
  }
  try {
    logger.info('Historical Tally invoice backfill triggered (2016-04-01 → now)');
    res.status(200).json({ success: true, message: 'Backfill started — this will run in background, check logs' });
    // Run async so HTTP response returns immediately
    const { getSalesVouchers } = require('./processors/tallyInvoiceProcessor');
    const { processTallyInvoicesFromVouchers } = require('./processors/tallyInvoiceProcessor');
    getSalesVouchers('2016-04-01')
      .then(vouchers => processTallyInvoicesFromVouchers(vouchers))
      .then(r => logger.info('Historical backfill completed', r))
      .catch(e => logger.error('Historical backfill failed', { message: e.message }));
  } catch (error) {
    logger.error('Historical backfill trigger failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// Manual payment sync trigger
app.post('/sync/payments', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('payment-sync')) {
    return res.status(403).json({ success: false, message: 'payment-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual payment sync triggered');
    const { processPayments } = require('./processors/paymentProcessor');
    const result = await processPayments();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('Manual payment sync failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// Manual inventory sync trigger
app.post('/sync/inventory', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('inventory-sync')) {
    return res.status(403).json({ success: false, message: 'inventory-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual inventory sync triggered');
    const { processInventory } = require('./processors/inventoryProcessor');
    const result = await processInventory();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('Manual inventory sync failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});
// Item-based invoice sync — Tally sales vouchers with product rows → Bitrix24 Smart Invoices
app.post('/sync/item-invoices', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('invoice-sync')) {
    return res.status(403).json({ success: false, message: 'invoice-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual item-based invoice sync triggered');
    const { processItemInvoices } = require('./processors/itemInvoiceBuilder');
    res.status(200).json({ success: true, message: 'Item invoice sync started' });
    processItemInvoices().catch(e => logger.error('Item invoice sync error', { message: e.message }));
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/sync/invoices', authMiddleware, async (req, res) => {
  const featureGate = (() => { try { return require('./services/featureGate'); } catch { return null; } })();
  if (featureGate && !featureGate.isEnabled('invoice-sync')) {
    return res.status(403).json({ success: false, message: 'invoice-sync not enabled on your plan' });
  }
  try {
    logger.info('Manual invoice poll triggered');
    const { pollInvoices } = require('./processors/invoicePoller');
    res.status(200).json({ success: true, message: 'Invoice poll started' });
    pollInvoices().catch(() => {});
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.use(express.static(path.join(__dirname, "../agent/installer")));
app.use(express.static(path.join(__dirname, "../agent")));

// Bitrix Agent Dashboard — license gated
app.get("/dashboard", (req, res) => {
  try {
    const { loadLicenseCache } = require('./services/lmsService');
    const cache = loadLicenseCache();
    if (!cache || cache.status !== 'active') {
      return res.status(403).send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"/>
        <style>
          body{font-family:Arial,sans-serif;background:#f4f6fa;display:flex;align-items:center;
               justify-content:center;min-height:100vh;margin:0;}
          .box{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;
               box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;}
          h2{color:#e53935;margin-bottom:8px;}p{color:#555;line-height:1.6;}
        </style></head><body>
        <div class="box">
          <h2>⚠ License Required</h2>
          <p>Your TallyBitrixSync license is not active.<br/>
          Please contact support or renew your subscription.</p>
          <p style="margin-top:16px;font-size:13px;color:#888;">
            Status: <strong>${cache?.status || 'not found'}</strong>
          </p>
        </div></body></html>
      `);
    }
  } catch { /* allow access if lmsService not yet initialized */ }
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