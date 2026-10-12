const { Schema, model } = require('mongoose')

// Cold storage for audit-log entries that fell outside the live retention window (see
// utils/auditLogRetention.js) — same shape as AuditLog itself (including its original _id, so an
// entry's identity survives the move) plus archivedAt. Never pruned itself; if this needs its own
// cleanup one day that's a deliberate separate decision, not a side effect of shortening the live
// window.
const auditLogArchiveSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, default: null },
    targetLabel: { type: String, default: '' },
    summary: { type: String, required: true },
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
    createdAt: { type: Date, required: true },
    archivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
)

auditLogArchiveSchema.index({ createdAt: -1 })

module.exports = model('AuditLogArchive', auditLogArchiveSchema)
