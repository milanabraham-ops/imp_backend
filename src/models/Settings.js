const { Schema, model } = require('mongoose')

// Singleton document — exactly one row, holding the Google Chat webhook config that used to
// live in .env. Admin-managed via /api/admin/settings so swapping a webhook never needs a code
// deploy or server restart.
const settingsSchema = new Schema(
  {
    gchatQaWebhookUrl: { type: String, default: '' },
    gchatPocWebhookUrl: { type: String, default: '' },
    // The Google Drive folder (Shared Drive id) audio/avatar uploads go into — used to live in
    // GOOGLE_DRIVE_FOLDER_ID, moved here since an admin swapping drives shouldn't need a deploy.
    // Blank by default (Drive uploads are simply skipped, falling back to GridFS, until an admin
    // sets a real one via Settings) — a real folder id belongs in this deployment's own Settings
    // document, not as a literal baked into the schema and checked into source control.
    googleDriveFolderId: { type: String, default: '' },

    // How many days an audit-log entry (see models/AuditLog.js) is kept before it's pruned.
    // Admin-adjustable since teams differ on how much detailed history they want to keep around —
    // the key facts (who submitted/reviewed it, its status, who last touched it) live permanently
    // on the Submission itself regardless, so shortening this only trims the detailed trail, never
    // that summary.
    auditLogRetentionDays: { type: Number, default: 30 },
  },
  { timestamps: true },
)

async function getSettings() {
  let doc = await this.findOne()
  if (!doc) doc = await this.create({})
  return doc
}

settingsSchema.statics.getSettings = getSettings

module.exports = model('Settings', settingsSchema)
