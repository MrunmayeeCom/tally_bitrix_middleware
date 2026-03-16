const app    = require('./app');
const config = require('./config/appConfig');
const logger = require('./utils/logger');
const { startScheduler }  = require('./scheduler');
const { setupPipeline }      = require('./services/pipelineService');
const { ensureTallyDefaults } = require('./services/tallyService');

app.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} | ENV: ${config.env}`);
  await setupPipeline();
  await ensureTallyDefaults();
  startScheduler();
});