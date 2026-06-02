/**
 * logger.js — Structured JSON logger for the Purplle Store Intelligence API.
 *
 * Uses winston for structured, levelled, machine-readable JSON logs.
 * Human-readable console format in development; JSON in production/Docker.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('Event processed', { event_type: 'entry', customer_id: 'ID_60001' });
 *   logger.warn('Anomaly detected', { type: 'LOITERING', customer_id: 'ID_60002' });
 *   logger.error('DB write failed', { error: err.message });
 */

const { createLogger, format, transports } = require('winston');

const isDev = process.env.NODE_ENV !== 'production';

const jsonFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  format.errors({ stack: true }),
  format.json()
);

const prettyFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isDev ? prettyFormat : jsonFormat,
  transports: [
    new transports.Console(),
  ],
  exitOnError: false,
});

// Convenience wrapper that attaches service metadata to every log entry
const storeLogger = {
  info:  (msg, meta = {}) => logger.info(msg,  { service: 'store-api', ...meta }),
  warn:  (msg, meta = {}) => logger.warn(msg,  { service: 'store-api', ...meta }),
  error: (msg, meta = {}) => logger.error(msg, { service: 'store-api', ...meta }),
  debug: (msg, meta = {}) => logger.debug(msg, { service: 'store-api', ...meta }),
  http:  (msg, meta = {}) => logger.http(msg,  { service: 'store-api', ...meta }),
};

module.exports = storeLogger;
