const app    = require('./app');
const config = require('./config/appConfig');
const logger = require('./utils/logger');
const { startScheduler }  = require('./scheduler');
const { setupPipeline }      = require('./services/pipelineService');
const { ensureTallyDefaults } = require('./services/tallyService');

app.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} | ENV: ${config.env}`);

  // Gate: pipeline-auto-setup — only run if license is active and feature enabled
  try {
    const featureGate = require('./services/featureGate');
    if (featureGate.isLicenseActive() && featureGate.isEnabled('pipeline-auto-setup')) {
      await setupPipeline();
    } else {
      logger.info('[LMS] pipeline-auto-setup skipped — no active license or feature not on plan');
    }
  } catch {
    logger.warn('[LMS] featureGate unavailable — skipping pipeline setup until license is validated');
  }

  await ensureTallyDefaults();

  // Load license features passed from Electron via env vars
  // This avoids waiting for LMS validation on every server start
  try {
    const featuresJson = process.env.LICENSE_FEATURES;
    const plan         = process.env.LICENSE_PLAN;
    if (featuresJson && plan) {
      const features = JSON.parse(featuresJson);
      const { setFeatures } = require('./services/featureGate');
      setFeatures(features, plan, true);
      logger.info(`[Server] License loaded from Electron env — Plan: ${plan}`);
    }
  } catch(e) {
    logger.warn('[Server] Could not load license from env: ' + e.message);
  }

  startScheduler();

  // Start event poller
  try {
    const { startPoller } = require('./services/eventPoller');
    const cfg = {
      customerEmail: process.env.CUSTOMER_EMAIL || '',
      bitrixUrl:     process.env.BITRIX_WEBHOOK_URL || '',
    };
    startPoller(cfg);
  } catch (err) {
    logger.warn('[Poller] Could not start event poller:', err.message);
  }
});