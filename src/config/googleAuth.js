const { google } = require('googleapis')

// Shared by googleSheets.js and googleDrive.js — same service-account credentials, different
// scopes depending on which API is being called.
function buildGoogleAuth(scopes) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n')
  return new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: key },
    scopes,
  })
}

module.exports = { buildGoogleAuth }
