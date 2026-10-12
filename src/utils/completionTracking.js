const { setCompletionInfo } = require('../services/sheetSync')
const { statusIsOneOf } = require('./statusMatch')
const logger = require('./logger')

// Fractional days with one decimal place, so work finished within the same day still shows a
// meaningful value (e.g. 0.3) instead of rounding down to a misleading 0.
function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a)
  const days = ms / (1000 * 60 * 60 * 24)
  return Math.max(0, Math.round(days * 10) / 10)
}

// The implementation work itself is done the moment a location is submitted for QA — the later
// move to COMPLETED is just the QA reviewer signing off on their own schedule, and doesn't reflect
// how long the actual setup took. So stamp Completion Date / Time Taken as soon as Configuration
// Status is first observed at QA (or COMPLETED, in case QA was skipped/missed), not at COMPLETED.
// `doc.completionDate` doubles as the "already stamped" guard so this only fires once per location.
// Status casing isn't meaningful (QA / qa / Qa are all the same), hence statusIsOneOf. MongoDB is
// the source of truth for configurationStatus — the Sheet is write-only storage, never read back.
async function stampCompletionIfNeeded(Submission, docs) {
  const now = new Date()
  const toStamp = docs.filter((doc) => !doc.completionDate && statusIsOneOf(doc.configurationStatus, ['QA', 'COMPLETED']))
  if (toStamp.length === 0) return

  const ops = toStamp.map((doc) => {
    const days = daysBetween(doc.createdAt, now)
    setCompletionInfo(doc, now, days).catch((err) => {
      logger.error({ err, submissionId: doc._id }, 'Failed to write completion info to Google Sheet')
    })
    return { updateOne: { filter: { _id: doc._id }, update: { $set: { completionDate: now, daysTakenToComplete: days } } } }
  })
  await Submission.bulkWrite(ops)
}

module.exports = { stampCompletionIfNeeded }
