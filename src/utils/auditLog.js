const AuditLog = require('../models/AuditLog')
const Submission = require('../models/Submission')
const logger = require('./logger')

// Fire-and-forget, same pattern as the rest of the app's side effects (Sheet sync, Chat
// notifications) — an audit entry failing to save should never block or fail the actual request.
function logAction({ actor, action, targetType, targetId, targetLabel, summary, changes }) {
  AuditLog.create({
    actorId: actor?._id || null,
    actorName: actor?.name || 'Unknown',
    actorRole: actor?.role || 'unknown',
    action,
    targetType,
    targetId: targetId || null,
    targetLabel: targetLabel || '',
    summary,
    changes: changes || [],
  }).catch((err) => logger.error({ err, action, targetType, targetId }, 'Failed to write audit log entry'))

  // The audit log itself gets pruned after its retention window — this standing snapshot on the
  // submission is what survives that, so "who last touched this, and when" is never lost.
  if (targetType === 'Submission' && targetId) {
    Submission.updateOne(
        { _id: targetId },
        {
          lastActivityAt: new Date(),
          lastActivityBy: actor?.name || 'Unknown',
          lastActivityByRole: actor?.role || 'unknown',
          lastActivitySummary: summary,
        },
      )
      .catch((err) => logger.error({ err, targetId }, 'Failed to stamp last activity on submission'))
  }
}

module.exports = { logAction }
