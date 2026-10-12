const AuditLog = require('../models/AuditLog')
const AuditLogArchive = require('../models/AuditLogArchive')
const Submission = require('../models/Submission')
const { pruneOldAuditLogs } = require('../utils/auditLogRetention')

const MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 50
const EXPORT_ROW_LIMIT = 10000

// When a targetId is given, this is a "view full history for this one thing" deep link (e.g. from
// SubmissionDetailModal), not the general personal-activity list — so the visibility model flips:
// instead of only the caller's own actions, everyone who could already see the target itself sees
// every action anyone took on it. A POC's access to *submissions* is already ownership-scoped
// everywhere else (see submissionController.getById), so a POC asking for a submission's history
// gets the same ownership check here before the actor-scoping is dropped; everyone else (specialist/
// qa/admin) already sees every submission's detail unrestricted, so no extra check is needed for
// them. Async because the POC path needs a DB lookup; throws an error carrying `.status` so the
// route's existing try/catch + errorHandler produce the right 403/404 without extra plumbing.
async function buildFilter(req) {
  let filter
  if (req.query.targetId) {
    const targetType = req.query.targetType || 'Submission'
    if (req.user.role === 'poc' && targetType === 'Submission') {
      let owned
      try {
        owned = await Submission.exists({ _id: req.query.targetId, owner: req.user._id })
      } catch (err) {
        if (err.name === 'CastError') {
          const notFound = new Error('Submission not found')
          notFound.status = 404
          throw notFound
        }
        throw err
      }
      if (!owned) {
        const forbidden = new Error('Submission not found')
        forbidden.status = 404
        throw forbidden
      }
    }
    filter = { targetId: req.query.targetId }
    if (req.query.targetType) filter.targetType = req.query.targetType
  } else {
    filter = req.user.role === 'admin' ? {} : { actorId: req.user._id }
    if (req.query.targetType) filter.targetType = req.query.targetType
  }

  const createdAt = {}
  if (req.query.startDate) {
    const start = new Date(req.query.startDate)
    if (!Number.isNaN(start.getTime())) createdAt.$gte = start
  }
  if (req.query.endDate) {
    // Treat the end date as inclusive of the whole day, not midnight at its start.
    const end = new Date(req.query.endDate)
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999)
      createdAt.$lte = end
    }
  }
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt

  return filter
}

// Quotes a CSV field only when needed (contains a comma, quote, or newline), doubling any embedded
// quotes — the standard minimal-escaping CSV rule. No new dependency for something this small.
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function csvRow(fields) {
  return fields.map(csvField).join(',') + '\r\n'
}

function pagingParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE))
  return { page, pageSize }
}

// Admin sees everything; everyone else sees only their own actions — matches the rest of the
// app's "specialist/qa/admin see every account, poc sees their own" pattern, but flipped here
// since an activity log about *other people's* actions isn't this feature's purpose for them.
// Paginated (page/pageSize) rather than the old flat capped-at-500 list, plus optional
// targetType/startDate/endDate filters — a single busy month could already exceed 500 entries,
// silently hiding everything older with no indication it had been cut off.
exports.list = async (req, res, next) => {
  try {
    const filter = await buildFilter(req)
    const { page, pageSize } = pagingParams(req)

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      AuditLog.countDocuments(filter),
    ])

    res.json({ logs, total, page, pageSize })

    // Opportunistic, same "stamp/clean up on read" pattern as attachManualStatus — a server-wide
    // timer (see server.js) also runs this daily so it still happens even if nobody opens this
    // page, but there's no reason not to also catch up right when someone does.
    pruneOldAuditLogs().catch((err) => req.log.error({ err }, 'Failed to prune old audit logs'))
  } catch (err) {
    next(err)
  }
}

// Admin-only — entries that aged out of the live retention window (see utils/auditLogRetention.js)
// but were archived rather than lost. Same filter/paging shape as the live list; deliberately a
// separate endpoint rather than folding into exports.list so the common case (the live window)
// never pays the cost of also querying cold storage.
exports.listArchive = async (req, res, next) => {
  try {
    const filter = await buildFilter(req)
    const { page, pageSize } = pagingParams(req)

    const [logs, total] = await Promise.all([
      AuditLogArchive.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      AuditLogArchive.countDocuments(filter),
    ])

    res.json({ logs, total, page, pageSize })
  } catch (err) {
    next(err)
  }
}

// Same filter/visibility as exports.list (including the targetId deep-link case above) but ignores
// paging entirely — a real export needs every matching row, not just whatever page happened to be
// open. Still hard-capped (EXPORT_ROW_LIMIT) so a very broad filter (e.g. an admin exporting with
// no filters at all) can't turn into an unbounded query; if more rows match than the cap, the file
// still downloads with the first EXPORT_ROW_LIMIT rows plus a trailing note rather than erroring out.
exports.export = async (req, res, next) => {
  try {
    const filter = await buildFilter(req)

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).limit(EXPORT_ROW_LIMIT),
      AuditLog.countDocuments(filter),
    ])

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="activity-log.csv"')

    res.write(csvRow(['Time', 'Actor', 'Role', 'Target Type', 'Target', 'Summary']))
    for (const log of logs) {
      res.write(
        csvRow([
          log.createdAt ? log.createdAt.toISOString() : '',
          log.actorName || '',
          log.actorRole || '',
          log.targetType || '',
          log.targetLabel || '',
          log.summary || '',
        ]),
      )
    }
    if (total > logs.length) {
      res.write(
        csvRow(['', '', '', '', '', `Export truncated — showing the first ${logs.length} of ${total} matching entries.`]),
      )
    }
    res.end()
  } catch (err) {
    next(err)
  }
}
