// config/logger.js — Logger simples (console + arquivo)
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeToFile(level, message, meta) {
  try {
    const line = JSON.stringify({ time: timestamp(), level, message, ...meta }) + '\n';
    fs.appendFileSync(path.join(LOG_DIR, 'combined.log'), line);
    if (level === 'error') {
      fs.appendFileSync(path.join(LOG_DIR, 'error.log'), line);
    }
  } catch (e) { /* não travar por erro de log */ }
}

function log(level, message, meta = {}) {
  const extra = Object.keys(meta).length ? JSON.stringify(meta) : '';
  const colors = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[90m' };
  const reset = '\x1b[0m';
  console.log(`${colors[level] || ''}[${timestamp()}] ${level.toUpperCase()}: ${message}${reset} ${extra}`);
  writeToFile(level, message, meta);
}

module.exports = {
  info:  (msg, meta) => log('info', msg, meta),
  warn:  (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta)
};
