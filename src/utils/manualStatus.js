const { stampCompletionIfNeeded } = require('./completionTracking')
const User = require('../models/User')
const logger = require('./logger')

// MongoDB is the sole source of truth for Account Onboarded / Configuration Status /
// Implementation Specialist — the Google Sheet is write-only storage (a durable record the
// team can browse), never read back into the app. The one thing every submission/group
// list-or-detail endpoint needs: convert each doc to a plain object, fire the
// auto-stamp-completion-info side effect, and attach the owning POC's Chat mention ID (if one's
// on file) so any message a specialist/QA composes about this submission — the handover message
// especially — can @-mention that specific person from the moment it's typed, not just once it's
// sent. Batched into one query for however many distinct owners are in this page of results,
// never per-submission.
async function attachManualStatus(Submission, docs) {
  stampCompletionIfNeeded(Submission, docs).catch((err) => {
    logger.error({ err }, 'Failed to stamp completion info')
  })

  const plain = docs.map((doc) => doc.toObject())

  const ownerIds = [...new Set(plain.map((s) => s.owner).filter(Boolean).map(String))]
  const chatIdByOwner = ownerIds.length
    ? new Map((await User.find({ _id: { $in: ownerIds } }).select('chatUserId')).map((u) => [String(u._id), u.chatUserId || '']))
    : new Map()

  for (const s of plain) {
    s.pocChatUserId = s.owner ? chatIdByOwner.get(String(s.owner)) || '' : ''
  }

  return plain
}

module.exports = { attachManualStatus }
