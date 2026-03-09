const app    = require('./app');
const config = require('./config/appConfig');
const logger = require('./utils/logger');
const { startScheduler } = require('./scheduler');

app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} | ENV: ${config.env}`);
  startScheduler();
});