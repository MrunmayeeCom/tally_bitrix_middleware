const app    = require('./app');
const config = require('./config/appConfig');
const logger = require('./utils/logger');
const { startScheduler }      = require('./scheduler');
const { setupPipeline }       = require('./services/pipelineService');
const { ensureTallyDefaults } = require('./services/tallyService');

// ── Guard against duplicate server starts (two Electron spawns) ──────────────
if (global._serverStarted) {
  logger.warn('[Server] Duplicate start blocked — server already running');
  process.exit(0);
}
global._serverStarted = true;

app.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} | ENV: ${config.env}`);

  // ── Step 1: Load license from Electron env FIRST (before anything else) ──
  try {
    const featuresJson = process.env.LICENSE_FEATURES;
    const plan         = process.env.LICENSE_PLAN;
    if (featuresJson && plan) {
      const features = JSON.parse(featuresJson);
      const { setFeatures } = require('./services/featureGate');
      setFeatures(features, plan, true);
      logger.info(`[Server] License loaded from Electron env — Plan: ${plan}`);
      logger.info(`[Server] Features loaded:`, features);
    } else {
      logger.warn('[Server] No LICENSE_FEATURES in env — featureGate will be empty until LMS validates');
    }
  } catch (e) {
    logger.warn('[Server] Could not load license from env: ' + e.message);
  }

  // ── Step 2: Pipeline setup (now featureGate is loaded) ───────────────────
  try {
    const featureGate = require('./services/featureGate');
    if (featureGate.isLicenseActive() && featureGate.isEnabled('pipeline-auto-setup')) {
      await setupPipeline();
    } else {
      logger.info('[LMS] pipeline-auto-setup skipped — no active license or feature not on plan');
    }
  } catch {
    logger.warn('[LMS] featureGate unavailable — skipping pipeline setup');
  }

  // ── Step 3: Ensure Tally defaults ────────────────────────────────────────
  await ensureTallyDefaults();

  // ── Step 4: Start scheduler (once only) ──────────────────────────────────
  if (!global._schedulerStarted) {
    global._schedulerStarted = true;
    const { isLicenseActive } = require('./services/featureGate');
    if (isLicenseActive()) {
      startScheduler();
    } else {
      logger.warn('[Scheduler] License not active at startup — retrying in 30s');
      setTimeout(() => {
        if (!global._schedulerActuallyStarted) {
          global._schedulerActuallyStarted = true;
          startScheduler();
        }
      }, 30000);
    }
  } else {
    logger.warn('[Scheduler] Already started — skipping duplicate');
  }

  // ── Step 5: Start event poller (once only) ───────────────────────────────
  if (!global._pollerStarted) {
    global._pollerStarted = true;
    try {
      const { startPoller } = require('./services/eventPoller');
      const cfg = {
        customerEmail: process.env.CUSTOMER_EMAIL || '',
        bitrixUrl:     process.env.BITRIX_WEBHOOK_URL || '',
      };
      await startPoller(cfg);
    } catch (err) {
      logger.warn('[Poller] Could not start event poller: ' + err.message);
    }
  } else {
    logger.warn('[Poller] Already started — skipping duplicate');
  }
});