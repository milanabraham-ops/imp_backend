const { google } = require('googleapis')
const { buildGoogleAuth } = require('./googleAuth')

let cachedClient = null

// Only the service-account credentials — the target Drive folder is admin-configured at runtime
// via Settings (see services/driveUpload.js's isConfigured), not an env var, since swapping
// drives shouldn't need a deploy. A client can be built with just credentials; which folder it
// writes into is decided later, per-call.
function hasCredentials() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
}

function getClient() {
  if (cachedClient) return cachedClient
  if (!hasCredentials()) return null

  const auth = buildGoogleAuth(['https://www.googleapis.com/auth/drive'])
  cachedClient = google.drive({ version: 'v3', auth })
  return cachedClient
}

module.exports = { getClient, hasCredentials }
