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
  startScheduler();

  // Start event poller — connects to Render server for Bitrix24 webhook events
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