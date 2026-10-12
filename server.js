require('dotenv').config()

const app = require('./src/app')
const connectDB = require('./src/config/db')
const { ensureHeaderRow } = require('./src/services/sheetSync')
const { pruneOldAuditLogs } = require('./src/utils/auditLogRetention')
const logger = require('./src/utils/logger')

const PORT = process.env.PORT || 5000
const AUDIT_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

connectDB()
  .then(() =>
    ensureHeaderRow().catch((err) => logger.error({ err }, 'Failed to ensure Google Sheet header row')),
  )
  .then(() => {
    app.listen(PORT, () => logger.info(`Server running on port ${PORT}`))

    // Runs once at startup (so a long-idle instance catches up immediately on restart, rather than
    // waiting a full day) and then daily — the audit log's retention window is meant to hold even
    // if nobody ever opens Activity Log to trigger the opportunistic prune in auditLogController.
    const prune = () => pruneOldAuditLogs().catch((err) => logger.error({ err }, 'Failed to prune old audit logs'))
    prune()
    setInterval(prune, AUDIT_LOG_PRUNE_INTERVAL_MS)
  })
  .catch((err) => {
    logger.error({ err }, 'Failed to start server')
    process.exit(1)
  })
