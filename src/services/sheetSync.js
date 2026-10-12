const { getClient, getSheetMeta, isConfigured } = require('../config/googleSheets')
const { withRetry } = require('../utils/retry')
const Submission = require('../models/Submission')
const logger = require('../utils/logger')
const {
  HEADER_ROW,
  mapSubmissionToRow,
  formatTimestamp,
  sheetText,
  ID_COLUMN_INDEX,
  CLIENT_NAME_COLUMN_INDEX,
  LOCATION_COLUMN_INDEX,
  ACCOUNT_ONBOARDED_COLUMN_INDEX,
  CONFIGURATION_STATUS_COLUMN_INDEX,
  IMPLEMENTATION_SPECIALIST_COLUMN_INDEX,
  COMPLETION_DATE_COLUMN_INDEX,
  TIME_TAKEN_COLUMN_INDEX,
  SYNCED_RANGES,
} = require('../config/sheetColumns')

function columnLetter(n) {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

async function ensureColumnCount(sheets, spreadsheetId, meta, minColumns) {
  if (meta.columnCount >= minColumns) return
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: meta.sheetId, gridProperties: { columnCount: minColumns } },
            fields: 'gridProperties.columnCount',
          },
        },
      ],
    },
  })
  meta.columnCount = minColumns
}

async function ensureHeaderRow() {
  if (!isConfigured()) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)
  await ensureColumnCount(sheets, spreadsheetId, meta, HEADER_ROW.length)

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${meta.title}!1:1` })
  const existingRow = existing.data.values?.[0] || []
  const matches = existingRow.length === HEADER_ROW.length && existingRow.every((v, i) => v === HEADER_ROW[i])
  if (matches) return

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${meta.title}!A1:${columnLetter(HEADER_ROW.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_ROW] },
  })

  if (existingRow.length > HEADER_ROW.length) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${meta.title}!${columnLetter(HEADER_ROW.length + 1)}1:${columnLetter(existingRow.length)}1`,
    })
  }
}

async function appendSubmissionRow(submission) {
  if (!isConfigured()) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)
  await ensureColumnCount(sheets, spreadsheetId, meta, HEADER_ROW.length)
  const row = mapSubmissionToRow(submission)

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${meta.title}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  })
}

async function findRowNumber(sheets, spreadsheetId, meta, submission) {
  const lastCol = columnLetter(HEADER_ROW.length)
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${meta.title}!A2:${lastCol}` })
  const rows = res.data.values || []
  const id = String(submission._id)

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][ID_COLUMN_INDEX] || '') === id) return i + 2
  }

  // Fallback for rows created before the Submission ID column existed: match on
  // client + location, but only among rows that don't already have an id of their own,
  // and only if the match is unambiguous.
  const clientName = submission.clientName || ''
  const locationName = submission.locationName || ''
  if (!clientName && !locationName) return null

  let candidate = null
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][ID_COLUMN_INDEX]) continue
    if ((rows[i][CLIENT_NAME_COLUMN_INDEX] || '') === clientName && (rows[i][LOCATION_COLUMN_INDEX] || '') === locationName) {
      if (candidate !== null) return null
      candidate = i + 2
    }
  }
  return candidate
}

async function updateSubmissionRow(submission) {
  if (!isConfigured()) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)
  await ensureColumnCount(sheets, spreadsheetId, meta, HEADER_ROW.length)
  const row = mapSubmissionToRow(submission)

  const rowNumber = await findRowNumber(sheets, spreadsheetId, meta, submission)
  if (rowNumber === null) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${meta.title}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
    return
  }

  const data = SYNCED_RANGES.map(([start, end]) => ({
    range: `${meta.title}!${columnLetter(start + 1)}${rowNumber}:${columnLetter(end + 1)}${rowNumber}`,
    values: [row.slice(start, end + 1)],
  }))

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  })
}

async function deleteSubmissionRow(submission) {
  if (!isConfigured()) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)

  const rowNumber = await findRowNumber(sheets, spreadsheetId, meta, submission)
  if (rowNumber === null) return

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        },
      ],
    },
  })
}

const MANUAL_FIELD_COLUMN_INDEX = {
  accountOnboarded: ACCOUNT_ONBOARDED_COLUMN_INDEX,
  configurationStatus: CONFIGURATION_STATUS_COLUMN_INDEX,
  implementationSpecialist: IMPLEMENTATION_SPECIALIST_COLUMN_INDEX,
}

// Account Onboarded / Configuration Status / Implementation Specialist are normally manual columns
// the implementation team fills in by hand directly in the sheet — but the app itself is now also a
// valid way to set them (via the specialist/QA queues, or account-onboarded inheritance for grouped
// locations), so those writes need to land in the sheet cell too, not just Mongo. Otherwise the next
// read prefers the sheet's still-blank value and silently reverts the app's own change.
async function setManualField(submission, field, value) {
  if (!isConfigured()) return
  const columnIndex = MANUAL_FIELD_COLUMN_INDEX[field]
  if (columnIndex === undefined) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)

  const rowNumber = await findRowNumber(sheets, spreadsheetId, meta, submission)
  if (rowNumber === null) return

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${meta.title}!${columnLetter(columnIndex + 1)}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  })
}

const setAccountOnboarded = (submission, value) => setManualField(submission, 'accountOnboarded', value)

// Completion Date and Time Taken to Complete Setup are normally manual columns, but once
// Configuration Status is first observed as COMPLETED the app fills these in automatically —
// the exact moment it noticed, and how many days that took from the location's own Timestamp.
async function setCompletionInfo(submission, completionDate, daysTaken) {
  if (!isConfigured()) return

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  const sheets = getClient()
  const meta = await getSheetMeta(sheets, spreadsheetId)

  const rowNumber = await findRowNumber(sheets, spreadsheetId, meta, submission)
  if (rowNumber === null) return

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${meta.title}!${columnLetter(COMPLETION_DATE_COLUMN_INDEX + 1)}${rowNumber}`,
          values: [[sheetText(formatTimestamp(completionDate))]],
        },
        {
          range: `${meta.title}!${columnLetter(TIME_TAKEN_COLUMN_INDEX + 1)}${rowNumber}`,
          values: [[daysTaken]],
        },
      ],
    },
  })
}

// Best-effort — recording that a sync failed/recovered should never itself throw or block the
// caller, so every failure here is swallowed (logged) rather than propagated.
async function recordSyncIssue(submissionId, service, message) {
  try {
    const current = await Submission.findById(submissionId).select('syncIssues').lean()
    if (!current) return
    const next = (current.syncIssues || []).filter((i) => i.service !== service)
    next.push({ service, message, at: new Date() })
    await Submission.updateOne({ _id: submissionId }, { $set: { syncIssues: next } })
  } catch (err) {
    logger.error({ err, submissionId, service }, 'Failed to record sync issue on submission')
  }
}

async function clearSyncIssue(submissionId, service) {
  try {
    await Submission.updateOne({ _id: submissionId }, { $pull: { syncIssues: { service: 'sheets' } } })
  } catch (err) {
    logger.error({ err, submissionId, service }, 'Failed to clear sync issue on submission')
  }
}

// Wraps a submission-taking sync function with retry (3 attempts, exponential backoff) plus
// persisting/clearing a 'sheets' syncIssues entry on that submission — every existing caller
// still just gets a resolved promise on success or a thrown error after retries are exhausted
// (same as before), so nothing downstream needs to change, but a transient failure now survives
// 3 attempts instead of 1, and if it still fails, that fact is visible on the submission itself
// instead of only a server log line.
function withSyncTracking(label, fn) {
  return async (submission, ...rest) => {
    try {
      const result = await withRetry(() => fn(submission, ...rest), { label })
      if (submission?._id) await clearSyncIssue(submission._id, 'sheets')
      return result
    } catch (err) {
      if (submission?._id) await recordSyncIssue(submission._id, 'sheets', err.message)
      throw err
    }
  }
}

module.exports = {
  ensureHeaderRow,
  appendSubmissionRow: withSyncTracking('Sheets: append row', appendSubmissionRow),
  updateSubmissionRow: withSyncTracking('Sheets: update row', updateSubmissionRow),
  deleteSubmissionRow: withSyncTracking('Sheets: delete row', deleteSubmissionRow),
  setAccountOnboarded: withSyncTracking('Sheets: set account onboarded', setAccountOnboarded),
  setManualField: withSyncTracking('Sheets: set manual field', setManualField),
  setCompletionInfo: withSyncTracking('Sheets: set completion info', setCompletionInfo),
}
