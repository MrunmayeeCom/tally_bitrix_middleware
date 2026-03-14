const logger = require('./logger');

// Retry a function up to maxAttempts times with exponential backoff
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    delayMs     = 2000,
    label       = 'operation'
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const wait = delayMs * attempt; // 2s, 4s, 6s
        logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms`, {
          message: err.message
        });
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  if (!options.silent) {
    logger.error(`${label} failed after ${maxAttempts} attempts`, { message: lastError.message });
  }
  throw lastError;
}

module.exports = { withRetry };