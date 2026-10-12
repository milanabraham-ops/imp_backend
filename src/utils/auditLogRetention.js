const AuditLog = require('../models/AuditLog')
const AuditLogArchive = require('../models/AuditLogArchive')
const Settings = require('../models/Settings')

const DEFAULT_RETENTION_DAYS = 30

// Detailed audit-log entries are only ever a trail of *how* things got to where they are — the
// facts that actually matter long-term (who submitted it, who's reviewing it, its status, who
// last touched it) live permanently on the Submission itself (see utils/auditLog.js), so shortening
// the live retention window loses nothing THAT survives elsewhere. The entries themselves used to
// just be hard-deleted, though — this now moves each one to AuditLogArchive (same shape, original
// _id preserved) first, so "who did what" stays retrievable indefinitely even after it drops out
// of the live 30-ish-day window; see auditLogController.listArchive for reading it back.
async function pruneOldAuditLogs() {
  const settings = await Settings.getSettings()
  const days = Number.isInteger(settings.auditLogRetentionDays) && settings.auditLogRetentionDays > 0 ? settings.auditLogRetentionDays : DEFAULT_RETENTION_DAYS
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const toArchive = await AuditLog.find({ createdAt: { $lt: cutoff } }).lean()
  if (toArchive.length > 0) {
    try {
      await AuditLogArchive.insertMany(
        toArchive.map((doc) => ({ ...doc, archivedAt: new Date() })),
        { ordered: false },
      )
    } catch (err) {
      // A duplicate _id (already archived by a prior run whose delete step then failed) shouldn't
      // block the delete below — insertMany with ordered:false still inserts every non-duplicate
      // before throwing, so this is just "some were already there," not data loss.
      if (err.code !== 11000 && !Array.isArray(err.writeErrors)) throw err
    }
  }

  const result = await AuditLog.deleteMany({ createdAt: { $lt: cutoff } })
  return result.deletedCount || 0
}

module.exports = { pruneOldAuditLogs, DEFAULT_RETENTION_DAYS }
