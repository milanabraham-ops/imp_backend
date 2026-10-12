const Settings = require('../models/Settings')
const { clearFolderCache } = require('../services/driveUpload')

function toPublicSettings(doc) {
  return {
    gchatQaWebhookUrl: doc.gchatQaWebhookUrl || '',
    gchatPocWebhookUrl: doc.gchatPocWebhookUrl || '',
    googleDriveFolderId: doc.googleDriveFolderId || '',
    auditLogRetentionDays: doc.auditLogRetentionDays ?? 30,
  }
}

exports.get = async (req, res, next) => {
  try {
    const doc = await Settings.getSettings()
    res.json(toPublicSettings(doc))
  } catch (err) {
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    const doc = await Settings.getSettings()
    const { gchatQaWebhookUrl, gchatPocWebhookUrl, googleDriveFolderId, auditLogRetentionDays } = req.body

    if (gchatQaWebhookUrl !== undefined) doc.gchatQaWebhookUrl = gchatQaWebhookUrl.trim()
    if (gchatPocWebhookUrl !== undefined) doc.gchatPocWebhookUrl = gchatPocWebhookUrl.trim()
    if (googleDriveFolderId !== undefined) doc.googleDriveFolderId = googleDriveFolderId.trim()

    if (auditLogRetentionDays !== undefined) {
      const days = Number(auditLogRetentionDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return res.status(400).json({ error: 'Retention must be a whole number of days between 1 and 3650' })
      }
      doc.auditLogRetentionDays = days
    }

    await doc.save()

    // The client/location -> Drive folder id cache is only valid for whichever root drive it
    // was resolved against — if the id just changed, every cached mapping now points at folders
    // that may not even exist under the new drive. Clearing it forces fresh lookups (and
    // fresh folder creation if needed) under the new root from the next upload on.
    if (googleDriveFolderId !== undefined) clearFolderCache()

    res.json(toPublicSettings(doc))
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}
