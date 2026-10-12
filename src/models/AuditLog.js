const { Schema, model } = require('mongoose')

// One entry per meaningful action (not every raw field write) — take-over/reassignment, status
// and onboarding changes, QA sign-off, handoff/handover, comments, and create/delete of
// submissions/groups/users, plus a rolled-up entry when a POC/admin edits the actual setup data
// (field names only, not full values — see utils/auditLog.js).
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, required: true },

    // A short machine-readable key, e.g. "submission.status_change" — lets the UI/future
    // filtering key off something stable instead of parsing the human-readable summary.
    action: { type: String, required: true },

    targetType: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, default: null, index: true },
    // Denormalized (e.g. "Acme Dental - Downtown") so the log reads clearly even after the
    // underlying submission/group/user is later renamed or deleted.
    targetLabel: { type: String, default: '' },

    summary: { type: String, required: true },
    // Field-level detail for the rolled-up "edited setup data" entry — object/array field values
    // are stored as '[changed]' rather than the real value, both to keep entries small and so a
    // sensitive field (PMS server access) is never persisted here even indirectly.
    changes: {
      type: [
        {
          field: { type: String, required: true },
          from: { type: Schema.Types.Mixed, default: '' },
          to: { type: Schema.Types.Mixed, default: '' },
          _id: false,
        },
      ],
      default: () => [],
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

auditLogSchema.index({ createdAt: -1 })

module.exports = model('AuditLog', auditLogSchema)
