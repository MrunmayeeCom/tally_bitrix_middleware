const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function getTimestamp() {
  return new Date().toISOString();
}

function writeToFile(filename, message) {
  const filePath = path.join(logDir, filename);
  fs.appendFileSync(filePath, message + '\n');
}

const logger = {
  info(message, data = '') {
    const log = `[${getTimestamp()}] INFO  ${message} ${data ? JSON.stringify(data) : ''}`;
    console.log(log);
    writeToFile('combined.log', log);
  },
  error(message, data = '') {
    const log = `[${getTimestamp()}] ERROR ${message} ${data ? JSON.stringify(data) : ''}`;
    console.error(log);
    writeToFile('combined.log', log);
    writeToFile('error.log', log);
  },
  warn(message, data = '') {
    const log = `[${getTimestamp()}] WARN  ${message} ${data ? JSON.stringify(data) : ''}`;
    console.warn(log);
    writeToFile('combined.log', log);
  }
};

module.exports = logger;