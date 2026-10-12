const { google } = require('googleapis')
const { buildGoogleAuth } = require('./googleAuth')

let cachedClient = null
let cachedSheetMeta = null

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
  )
}

function getClient() {
  if (cachedClient) return cachedClient
  if (!isConfigured()) return null

  const auth = buildGoogleAuth(['https://www.googleapis.com/auth/spreadsheets'])
  cachedClient = google.sheets({ version: 'v4', auth })
  return cachedClient
}

async function getSheetMeta(sheets, spreadsheetId) {
  if (cachedSheetMeta) return cachedSheetMeta
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const first = meta.data.sheets[0].properties
  cachedSheetMeta = { sheetId: first.sheetId, title: first.title, columnCount: first.gridProperties?.columnCount || 26 }
  return cachedSheetMeta
}

module.exports = { getClient, getSheetMeta, isConfigured }
