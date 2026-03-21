const app    = require('./app');
const config = require('./config/appConfig');
const logger = require('./utils/logger');
const { startScheduler }  = require('./scheduler');
const { setupPipeline }      = require('./services/pipelineService');
const { ensureTallyDefaults } = require('./services/tallyService');

app.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} | ENV: ${config.env}`);

  // Gate: pipeline-auto-setup — skip pipeline creation on lower plans
  try {
    const featureGate = require('./services/featureGate');
    if (featureGate.isEnabled('pipeline-auto-setup')) {
      await setupPipeline();
    } else {
      logger.info('[LMS] pipeline-auto-setup not enabled — skipping pipeline creation');
    }
  } catch {
    // featureGate not yet loaded (first boot before LMS validation) — always setup
    await setupPipeline();
  }

  await ensureTallyDefaults();
  startScheduler();
});