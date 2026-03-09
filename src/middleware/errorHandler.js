const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
}

module.exports = errorHandler;