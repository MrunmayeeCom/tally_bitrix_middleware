const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function getTimestamp() {
  return new Date().toISOString();
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function writeToFile(filename, message) {
  const filePath = path.join(logDir, filename);
  try {
    // Rotate if over 5MB
    if (fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      if (size > MAX_LOG_SIZE) {
        const archivePath = filePath.replace('.log', `-${Date.now()}.log`);
        fs.renameSync(filePath, archivePath);
        // Keep only last 3 archives
        const dir = path.dirname(filePath);
        const base = path.basename(filePath, '.log');
        const archives = fs.readdirSync(dir)
          .filter(f => f.startsWith(base + '-') && f.endsWith('.log'))
          .sort();
        while (archives.length > 3) {
          fs.unlinkSync(path.join(dir, archives.shift()));
        }
      }
    }
    fs.appendFileSync(filePath, message + '\n');
  } catch {}
}

let _consecutiveErrors = 0;
const ERROR_ALERT_THRESHOLD = 3;

const logger = {
  info(message, data = '') {
    const log = `[${getTimestamp()}] INFO  ${message} ${data ? JSON.stringify(data) : ''}`;
    console.log(log);
    writeToFile('combined.log', log);
    _consecutiveErrors = 0; // reset on success
  },
  error(message, data = '') {
    const log = `[${getTimestamp()}] ERROR ${message} ${data ? JSON.stringify(data) : ''}`;
    console.error(log);
    writeToFile('combined.log', log);

    // Only write to error.log and send alerts if error-logging is enabled on plan
    try {
      const featureGate = require('../services/featureGate');
      if (featureGate.isEnabled('error-logging')) {
        writeToFile('error.log', log);
        _consecutiveErrors++;
        if (_consecutiveErrors >= ERROR_ALERT_THRESHOLD) {
          logger.warn(`[Alert] ${_consecutiveErrors} consecutive errors — admin notification would fire here`);
          _consecutiveErrors = 0;
        }
      }
    } catch {
      writeToFile('error.log', log); // fallback — always write if featureGate unavailable
    }
  },
  warn(message, data = '') {
    const log = `[${getTimestamp()}] WARN  ${message} ${data ? JSON.stringify(data) : ''}`;
    console.warn(log);
    writeToFile('combined.log', log);
  },
  debug(message, data = '') {
    if (process.env.NODE_ENV !== 'production') {
      const log = `[${getTimestamp()}] DEBUG ${message} ${data ? JSON.stringify(data) : ''}`;
      console.log(log);
    }
  }
};

module.exports = logger;