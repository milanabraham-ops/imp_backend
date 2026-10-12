const pino = require('pino')

// Structured JSON logging (level, timestamp, whatever context object is passed) instead of a bare
// console.error(err.message) with no way to filter by severity or correlate related lines — every
// error path in this app used to just be that. LOG_LEVEL is admin/deploy-configurable (defaults to
// 'info'); pino-pretty renders human-readable colored output in development only — production
// (Render) gets raw JSON lines, which is what a log aggregator actually wants to ingest.
const isProd = process.env.NODE_ENV === 'production'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
})

module.exports = logger
