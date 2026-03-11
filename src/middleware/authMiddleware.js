const logger = require('../utils/logger');

function authMiddleware(req, res, next) {
  // Skip auth in development
  if (process.env.NODE_ENV === 'development') return next();

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const validKey = process.env.API_SECRET_KEY;

  if (!validKey) {
    logger.warn('API_SECRET_KEY not set — auth skipped');
    return next();
  }

  if (!apiKey || apiKey !== validKey) {
    logger.warn('Unauthorized request blocked', {
      ip:  req.ip,
      url: req.originalUrl
    });
    return res.status(401).json({ success: false, message: 'Unauthorized — invalid or missing API key' });
  }

  next();
}

module.exports = { authMiddleware };