const Submission = require('../models/Submission')
const Group = require('../models/Group')
const User = require('../models/User')
const {
  appendSubmissionRow,
  updateSubmissionRow,
  deleteSubmissionRow,
  setAccountOnboarded,
  setManualField,
} = require('../services/sheetSync')
const { attachManualStatus } = require('../utils/manualStatus')
const { statusEquals, normalizeStatus } = require('../utils/statusMatch')
const { notifyNewRequest, postToQaGroup, postToPocGroup } = require('../services/chatService')
const { logAction } = require('../utils/auditLog')
const { normalizePhoneNumber } = require('../utils/phoneNumber')
const { parseCsv, parseCsvBoolean, splitCsvSections, mapTableRows } = require('../utils/csvParse')
const XLSX = require('xlsx')

// Roles that manage the client relationship itself (creating/deleting submissions and groups).
// Specialist/QA only ever act on tracking fields of records that already exist.
const OWNER_ROLES = ['poc', 'admin']
// QA can also pick up and perform configuration work themselves (same fields as specialist),
// in addition to their own verification/onboarding sign-off — specialist cannot do QA's part.
// Account Onboarded belongs to whoever is actually doing the account at the time (specialist
// while configuring, QA during review), not just QA — so both can set it.
// Integration work (hooking a location's PMS up to the phone system) has no specialist/QA split —
// anyone but a POC can pick one up, so both roles get the same two fields. forwardingNumbers and
// forwardingNumberRequired are here too (not gated like the rest) purely so specialist/qa can reach
// them through this same PATCH — a POC already can, since neither is ever stripped as a tracking
// field for them (see stripTrackingFields) and admin gets everything regardless.
const TRACKING_FIELDS_BY_ROLE = {
  specialist: [
    'configurationStatus',
    'implementationSpecialist',
    'accountOnboarded',
    'statusBeforeHold',
    'integrationStatus',
    'integrationAgent',
    'forwardingNumbers',
    'forwardingNumberRequired',
  ],
  qa: [
    'configurationStatus',
    'implementationSpecialist',
    'accountOnboarded',
    'qaAgent',
    'statusBeforeHold',
    'qaChecklist',
    'integrationStatus',
    'integrationAgent',
    'forwardingNumbers',
    'forwardingNumberRequired',
  ],
}
const MANUAL_TRACKING_FIELDS = ['accountOnboarded', 'configurationStatus', 'implementationSpecialist']

// A "CS Voicestack" environment is always already wired to CareStack directly (see FormWizard's
// own environment-change effect, which forces pms to 'CareStack' the moment it's selected) — it
// never needs a custom integration ticket. Any other environment does, once a PMS is actually
// specified (nothing to integrate yet if that's still blank).
function needsIntegration(data) {
  const environment = (data.environment || '').trim().toLowerCase()
  const pms = (data.pms || '').trim()
  return environment !== 'cs voicestack' && Boolean(pms)
}

// Account Onboarded is a property of the client account as a whole, not each individual location —
// once any location in a group has been closed out, the account is onboarded for good. So a new
// location added afterward should immediately show Closed too, instead of starting blank.
async function inheritOnboardedStatus(submission, groupId) {
  const siblings = await Submission.find({ group: groupId, _id: { $ne: submission._id } })
  if (siblings.length === 0) return

  const alreadyOnboarded = siblings.some((s) => statusEquals(s.accountOnboarded, 'CLOSED'))
  if (!alreadyOnboarded) return

  submission.accountOnboarded = 'Closed'
  await submission.save()
  await setAccountOnboarded(submission, 'Closed')
}

// Fields nobody should ever be able to set through this general PATCH/POST, no matter the role —
// stripped here (ahead of fieldsForRole) so this applies uniformly, admin included, rather than
// needing every TRACKING_FIELDS_BY_ROLE list to know to exclude them. Shared by create() too, so
// `group` (which create() DOES read off the stripped body, to attach a new location to a group at
// creation time) deliberately isn't in this list — update() strips it separately below, since
// there's no "reassign to a different group" feature and it should never be settable there.
//
// Two kinds here: Chat-message-only fields never persisted to the Submission document at all, and
// fields with their own dedicated write path elsewhere (comments via addComment, qaChecklist/
// completion timestamps via the QA-complete flow, handoff/handover timestamps set directly by
// this same controller, the audit-derived lastActivity*/lastPocEdit* snapshots, and Mongoose's own
// __v). Because the frontend wizard resends its whole cached copy of the submission on every save
// rather than just a diff, any of these left un-stripped would silently roll back to whatever
// stale value the client loaded — invisibly overwriting e.g. a QA checklist someone else filled
// in since, or a new comment. forwardingNumbers is NOT in this list — it's a plain editable field
// like any other, just also reachable by specialist/qa via TRACKING_FIELDS_BY_ROLE above.
function stripProtectedFields(body) {
  const {
    owner: _owner,
    _id,
    __v,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    pocMessage: _pocMessage,
    qaHandoffMessage: _qaHandoffMessage,
    qaResultMessage: _qaResultMessage,
    isRecheck: _isRecheck,
    isTestData: _isTestData,
    comments: _comments,
    completionDate: _completionDate,
    daysTakenToComplete: _daysTakenToComplete,
    pocHandoverAt: _pocHandoverAt,
    qaHandoffAt: _qaHandoffAt,
    lastActivityAt: _lastActivityAt,
    lastActivityBy: _lastActivityBy,
    lastActivityByRole: _lastActivityByRole,
    lastActivitySummary: _lastActivitySummary,
    lastPocEditAt: _lastPocEditAt,
    lastPocEditSummary: _lastPocEditSummary,
    integrationTicketCreatedAt: _integrationTicketCreatedAt,
    integrationCompletedAt: _integrationCompletedAt,
    syncIssues: _syncIssues,
    ...rest
  } = body
  return rest
}

// A POC never touches anything in the tracking domain — not just the 4 status/assignment fields,
// but the QA-only ones too (qaChecklist, statusBeforeHold), and the integration ones, since a POC
// resending their stale cached copy of any of these would silently blow away work someone else has
// done in the meantime. A POC CAN still edit the actual pms/serverAccess fields that feed
// needsIntegration() below — those are ordinary setup data, just read (never written) by this file.
function stripTrackingFields(body) {
  const {
    accountOnboarded: _accountOnboarded,
    configurationStatus: _configurationStatus,
    implementationSpecialist: _implementationSpecialist,
    qaAgent: _qaAgent,
    qaChecklist: _qaChecklist,
    statusBeforeHold: _statusBeforeHold,
    integrationStatus: _integrationStatus,
    integrationAgent: _integrationAgent,
    ...rest
  } = body
  return rest
}

// What a given role is allowed to change on an existing submission via PATCH.
// poc: everything except the 3 tracking fields (those are set by specialist/qa/admin instead).
// admin: everything, including tracking fields.
// specialist / qa: ONLY their own tracking field(s) — never the client's actual setup data.
function fieldsForRole(role, body) {
  const base = stripProtectedFields(body)
  if (role === 'admin') return base
  if (role === 'poc') return stripTrackingFields(base)
  const allowed = TRACKING_FIELDS_BY_ROLE[role] || []
  const out = {}
  for (const key of allowed) {
    if (base[key] !== undefined) out[key] = base[key]
  }
  return out
}

function isMineName(fieldValue, name) {
  return (fieldValue || '').trim().toLowerCase() === (name || '').trim().toLowerCase()
}

// Once a submission has reached QA (in QA, paused mid-QA-review, or already Completed by QA),
// the QA agent is the active owner for status/onboarded edits — including recheck/handover on a
// Completed one, which are QA actions too. Otherwise it's still the specialist's.
function isInQaDomain(submission) {
  if (statusEquals(submission.configurationStatus, 'QA') || statusEquals(submission.configurationStatus, 'Completed')) return true
  return statusEquals(submission.configurationStatus, 'On Hold') && statusEquals(submission.statusBeforeHold, 'QA')
}

function activeOwnerName(submission) {
  return isInQaDomain(submission) ? submission.qaAgent : submission.implementationSpecialist
}

// Once someone has taken a task, only they (or an admin) can touch it — reassign/release who
// owns it, or change its status/onboarded fields. Admin has full drag/edit rights across the
// whole board by design, same as the kanban UI's ownership gate — enforced here too since the
// UI-only gate can't stop a direct API call. Not yet taken by anyone means there's nothing to
// protect, so the take-over action itself (claiming an unassigned submission) is unaffected.
function stripForeignOwnershipEdits(submission, updates, requesterName, requesterRole) {
  const out = { ...updates }
  if (requesterRole === 'admin') return out
  if (out.qaAgent !== undefined && submission.qaAgent && !isMineName(submission.qaAgent, requesterName)) {
    delete out.qaAgent
  }
  if (
    out.implementationSpecialist !== undefined &&
    submission.implementationSpecialist &&
    !isMineName(submission.implementationSpecialist, requesterName)
  ) {
    delete out.implementationSpecialist
  }

  const owner = activeOwnerName(submission)
  // Once a submission has been handed to QA, only qa/admin may ever move it further — never
  // specialist, even if nobody has actually claimed the QA review yet (owner blank). The
  // ownership-by-name check below only narrows *which* qa/admin once someone has claimed it; it
  // was never meant to let a specialist jump straight to Completed just because it's unclaimed.
  if (isInQaDomain(submission) && requesterRole === 'specialist') {
    delete out.configurationStatus
    delete out.accountOnboarded
    delete out.statusBeforeHold
  } else if (owner && !isMineName(owner, requesterName)) {
    delete out.configurationStatus
    delete out.accountOnboarded
    delete out.statusBeforeHold
  }

  // Integration is its own independent workflow with its own owner — same "only the current
  // owner may touch it" rule, entirely separate from configurationStatus/qaAgent above.
  if (out.integrationAgent !== undefined && submission.integrationAgent && !isMineName(submission.integrationAgent, requesterName)) {
    delete out.integrationAgent
  }
  if (submission.integrationAgent && !isMineName(submission.integrationAgent, requesterName)) {
    delete out.integrationStatus
  }
  return out
}

// Once an integration ticket exists, pms is locked to whoever originally submitted the request —
// including admin, unlike every other ownership rule in this file (see the early admin return
// above). Integration work may already be underway against the current PMS value; letting anyone
// else change it later would silently relabel that in-flight ticket with no record of what it
// actually started against. The owner can still fix their own mistake at any time.
function stripLockedPmsEdit(submission, updates, requesterId) {
  if (updates.pms === undefined) return updates
  if (!submission.integrationTicketCreatedAt) return updates
  if (String(submission.owner) === String(requesterId)) return updates
  const { pms: _pms, ...rest } = updates
  return rest
}

function submissionLabel(submission) {
  return `${submission.clientName || 'Untitled'} - ${submission.locationName || 'Untitled location'}`
}

// One number per line — keeps the first occurrence of each (by digits only, via
// normalizePhoneNumber) and drops any later line that's the same number in a different format.
function dedupeForwardingNumbers(text) {
  const seen = new Set()
  const lines = (text || '').split('\n')
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const normalized = normalizePhoneNumber(trimmed)
    if (normalized && seen.has(normalized)) continue
    if (normalized) seen.add(normalized)
    kept.push(trimmed)
  }
  return kept.join('\n')
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(value[k])
        return acc
      }, {})
  }
  return value
}

// Order-independent equality for "did this field actually change" — a plain JSON.stringify
// comparison is sensitive to object key order, which a Mongoose subdocument can drift on across
// saves (its live in-memory order vs. one recast from a client's JSON-round-tripped resend) even
// when nothing meaningful changed. JSON round-tripping first turns Mongoose documents/ObjectIds/
// Dates into plain JSON-safe values (what toJSON/toObject would produce); sortKeysDeep then makes
// key order a non-issue. Array element order is preserved (and does matter — e.g. ring group order).
function stableSerialize(value) {
  const plain = value === undefined ? null : JSON.parse(JSON.stringify(value))
  return JSON.stringify(sortKeysDeep(plain))
}

// Bookkeeping fields that move alongside a tracked change but aren't meaningful on their own
// (statusBeforeHold, the two Chat-notification timestamps) and the checklist (summarized inside
// the status-change entry itself instead of listed as its own "edited field"). Never surfaced as
// a standalone "edited setup data" entry.
const SILENT_FIELDS = new Set(['statusBeforeHold', 'qaChecklist', 'qaHandoffAt', 'pocHandoverAt'])
const TRACKED_FIELDS = new Set([
  'implementationSpecialist',
  'qaAgent',
  'configurationStatus',
  'accountOnboarded',
  'integrationStatus',
  'integrationAgent',
])
// Real PMS login credentials, encrypted at rest — must never land in the audit log even as a
// "before/after" value, so only the fact that it changed is recorded.
const REDACTED_FIELDS = new Set(['serverAccess'])

function serializeFieldChange(field, from, to) {
  if (REDACTED_FIELDS.has(field)) return { field, from: '[redacted]', to: '[redacted]' }
  if (typeof from === 'object' || typeof to === 'object') return { field, from: '[changed]', to: '[changed]' }
  return { field, from: from ?? '', to: to ?? '' }
}

function describeStatusChange({ prev, next, isRecheck, hasQaHandoffMessage, submission }) {
  const prevLabel = prev || 'Not Started'
  const nextNorm = normalizeStatus(next)
  if (nextNorm === 'COMPLETED') {
    const flagged = (submission.qaChecklist || []).filter((i) => i.status === 'error' || i.status === 'clarification').length
    return `Marked QA complete${flagged ? ` (${flagged} item${flagged === 1 ? '' : 's'} flagged)` : ''}`
  }
  if (nextNorm === 'QA' && isRecheck) return 'Reopened for recheck (back to QA)'
  if (nextNorm === 'QA' && hasQaHandoffMessage) return 'Handed off to QA for review'
  if (nextNorm === 'ON HOLD') return `Put on hold (was ${prevLabel})`
  return `Changed configuration status from ${prevLabel} to ${next || 'Not Started'}`
}

// Turns one PATCH's before/after values into one-or-more human-readable audit entries — a
// take-over/reassignment, a status or onboarding change, and/or a single rolled-up entry for
// whatever actual setup-data fields the requester also touched (so an edit to a dozen form
// fields is one log line, not a dozen).
function buildSubmissionAuditEntries({ before, submission, req }) {
  const entries = []
  const changedKeys = Object.keys(before).filter((k) => stableSerialize(before[k]) !== stableSerialize(submission[k]))

  if (changedKeys.includes('implementationSpecialist')) {
    const prev = before.implementationSpecialist
    const next = submission.implementationSpecialist
    if (!prev && next) {
      entries.push({
        action: isMineName(next, req.user.name) ? 'submission.take_over_specialist' : 'submission.assign_specialist',
        summary: isMineName(next, req.user.name) ? 'Took over as implementation specialist' : `Assigned ${next} as implementation specialist`,
      })
    } else if (prev && next && prev !== next) {
      entries.push({ action: 'submission.reassign_specialist', summary: `Reassigned specialist from ${prev} to ${next}` })
    } else if (prev && !next) {
      entries.push({ action: 'submission.release_specialist', summary: `Released as implementation specialist (was ${prev})` })
    }
  }

  if (changedKeys.includes('qaAgent')) {
    const prev = before.qaAgent
    const next = submission.qaAgent
    if (!prev && next) {
      entries.push({
        action: isMineName(next, req.user.name) ? 'submission.take_over_qa' : 'submission.assign_qa',
        summary: isMineName(next, req.user.name) ? 'Took over for QA review' : `Assigned ${next} for QA review`,
      })
    } else if (prev && next && prev !== next) {
      entries.push({ action: 'submission.reassign_qa', summary: `Reassigned QA reviewer from ${prev} to ${next}` })
    } else if (prev && !next) {
      entries.push({ action: 'submission.release_qa', summary: `Released as QA reviewer (was ${prev})` })
    }
  }

  if (changedKeys.includes('configurationStatus')) {
    entries.push({
      action: 'submission.status_change',
      summary: describeStatusChange({
        prev: before.configurationStatus,
        next: submission.configurationStatus,
        isRecheck: Boolean(req.body.isRecheck),
        hasQaHandoffMessage: Boolean(req.body.qaHandoffMessage && req.body.qaHandoffMessage.trim()),
        submission,
      }),
    })
  }

  if (changedKeys.includes('accountOnboarded')) {
    entries.push({
      action: 'submission.account_onboarded_change',
      summary: `Set account onboarded to ${submission.accountOnboarded || 'blank'}`,
    })
  }

  if (changedKeys.includes('integrationAgent')) {
    const prev = before.integrationAgent
    const next = submission.integrationAgent
    if (!prev && next) {
      entries.push({
        action: isMineName(next, req.user.name) ? 'submission.take_over_integration' : 'submission.assign_integration',
        summary: isMineName(next, req.user.name) ? 'Took over the integration' : `Assigned ${next} to the integration`,
      })
    } else if (prev && next && prev !== next) {
      entries.push({ action: 'submission.reassign_integration', summary: `Reassigned integration from ${prev} to ${next}` })
    } else if (prev && !next) {
      entries.push({ action: 'submission.release_integration', summary: `Released the integration (was ${prev})` })
    }
  }

  if (changedKeys.includes('integrationStatus')) {
    entries.push({
      action: 'submission.integration_status_change',
      summary: `Changed integration status from ${before.integrationStatus || 'Needle Request (OneApi Cred)'} to ${submission.integrationStatus || 'Needle Request (OneApi Cred)'}`,
    })
  }

  // Everything else the requester touched is the actual setup data (a POC editing their own
  // form, or an admin editing on their behalf) — never a tracking field, since those are always
  // one of the cases above already.
  const dataFields = changedKeys.filter((k) => !TRACKED_FIELDS.has(k) && !SILENT_FIELDS.has(k))
  if (dataFields.length) {
    entries.push({
      action: 'submission.edit',
      summary: `Edited ${dataFields.length} field${dataFields.length === 1 ? '' : 's'}: ${dataFields.slice(0, 6).join(', ')}${
        dataFields.length > 6 ? ', …' : ''
      }`,
      changes: dataFields.map((f) => serializeFieldChange(f, before[f], submission[f])),
    })
  }

  return entries
}

function logSubmissionAuditEntries(entries, { req, submission }) {
  for (const entry of entries) {
    logAction({
      actor: req.user,
      action: entry.action,
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: entry.summary,
      changes: entry.changes,
    })
  }
}

exports.create = async (req, res, next) => {
  try {
    if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const body = stripTrackingFields(stripProtectedFields(req.body))
    if (body.group) {
      const groupFilter = req.user.role === 'admin' ? { _id: body.group } : { _id: body.group, owner: req.user._id }
      const group = await Group.findOne(groupFilter)
      if (!group) return res.status(400).json({ error: 'Invalid group' })
    }

    const createPayload = { ...body, owner: req.user._id, isTestData: Boolean(req.user.isTestAccount) }
    if (needsIntegration(body)) {
      createPayload.integrationStatus = 'Needle Request (OneApi Cred)'
      createPayload.integrationTicketCreatedAt = new Date()
    }

    const submission = await Submission.create(createPayload)
    res.status(201).json(submission)

    logAction({
      actor: req.user,
      action: 'submission.create',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: submission.group ? 'Submitted a new location to a group' : 'Submitted a new location',
    })

    if (submission.integrationTicketCreatedAt) {
      logAction({
        actor: req.user,
        action: 'submission.integration_ticket_created',
        targetType: 'Submission',
        targetId: submission._id,
        targetLabel: submissionLabel(submission),
        summary: `Integration ticket created (PMS: ${submission.pms})`,
      })
    }

    appendSubmissionRow(submission)
      .then(() => (submission.group ? inheritOnboardedStatus(submission, submission.group) : null))
      .catch((err) => {
        req.log.error({ err, submissionId: submission._id }, 'Failed to sync submission to Google Sheet')
      })

    notifyNewRequest(submission).catch((err) => {
      req.log.error({ err, submissionId: submission._id }, 'Failed to send new-request Chat notification')
    })

    // POC's own edited message to their client-facing space — optional (only sent if they
    // actually wrote/kept one), separate from the fixed bot message to the QA/specialist group.
    if (req.body.pocMessage && req.body.pocMessage.trim()) {
      postToPocGroup(req.body.pocMessage.trim()).catch((err) => {
        req.log.error({ err, submissionId: submission._id }, 'Failed to send new-request Chat message to POC group')
      })
    }
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid group' })
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message })
    }
    next(err)
  }
}

// Only standalone (non-grouped) submissions — locations that belong to a multi-location group
// are listed via GET /api/groups/:id instead, so they aren't double-counted on the dashboard.
// Specialist/QA/Admin aren't scoped to "their own" — they need visibility across every account.
//
// Pagination is opt-in (page/pageSize query params) — the kanban boards (Pipeline/Dashboard/
// Integrations) need every card in one response to bucket them into columns client-side, so they
// keep calling this with no params and get the exact same flat array as before. A future
// non-kanban consumer (or a very large account) can ask for a page and gets back
// {submissions, total, page, pageSize} instead.
exports.list = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { owner: req.user._id, group: null } : {}

    if (req.query.page || req.query.pageSize) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
      const [rows, total] = await Promise.all([
        Submission.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize),
        Submission.countDocuments(filter),
      ])
      const submissions = await attachManualStatus(Submission, rows)
      return res.json({ submissions, total, page, pageSize })
    }

    const submissions = await Submission.find(filter).sort({ createdAt: -1 })
    res.json(await attachManualStatus(Submission, submissions))
  } catch (err) {
    next(err)
  }
}

exports.getById = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })
    const [merged] = await attachManualStatus(Submission, [submission])
    res.json(merged)
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    next(err)
  }
}

// Manual recovery for a persisted syncIssues entry (see models/Submission.js) — re-runs
// updateSubmissionRow, which is a full, idempotent "make the Sheet row match Mongo" write rather
// than trying to replay whatever specific operation originally failed (append/setManualField/
// setCompletionInfo). withSyncTracking (see services/sheetSync.js) clears the 'sheets' issue on
// success the same way any other successful sync would, so this doesn't need its own separate
// clear-the-flag logic.
exports.retrySync = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    try {
      await updateSubmissionRow(submission)
    } catch (err) {
      return res.status(502).json({ error: `Sync still failing: ${err.message}` })
    }

    // Re-fetch rather than reuse the in-memory `submission` — withSyncTracking already cleared
    // syncIssues in the database on that successful call above, but this in-memory copy was
    // loaded before that and would otherwise still show the stale, now-resolved entry.
    const refreshed = await Submission.findById(submission._id)
    const [merged] = await attachManualStatus(Submission, [refreshed])
    res.json(merged)
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    let updates = stripForeignOwnershipEdits(submission, fieldsForRole(req.user.role, req.body), req.user.name, req.user.role)
    updates = stripLockedPmsEdit(submission, updates, req.user._id)
    // No "move to a different group" feature exists — group is only ever set at creation. Stripped
    // here rather than in stripProtectedFields since create() needs that same field to survive.
    delete updates.group
    // One number per line, typed in by whoever notices it — de-duplicated by digits only (see
    // utils/phoneNumber.js) so the same number typed in two different formats on separate lines
    // (by the same person, or two different people editing around the same time) doesn't end up
    // listed twice; first occurrence's formatting wins.
    if (updates.forwardingNumbers !== undefined) {
      updates.forwardingNumbers = dedupeForwardingNumbers(updates.forwardingNumbers)
    }
    if (Object.keys(updates).length === 0) {
      return res.status(403).json({ error: 'You are not allowed to edit this' })
    }

    const before = {}
    for (const key of Object.keys(updates)) before[key] = submission[key]

    Object.assign(submission, updates)

    const entries = buildSubmissionAuditEntries({ before, submission, req })

    // A POC editing the actual setup data (as opposed to a tracking field, which a POC can't
    // touch at all — see fieldsForRole) is the one edit specialist/QA/admin need to hear about,
    // since it can invalidate work already in progress. Stamped alongside the edit itself (one
    // save, not two) so the notification poll has both a timestamp and a one-line summary to show.
    if (req.user.role === 'poc') {
      const editEntry = entries.find((e) => e.action === 'submission.edit')
      if (editEntry) {
        submission.lastPocEditAt = new Date()
        submission.lastPocEditSummary = editEntry.summary
      }
    }

    // A PMS added (or the environment changed away from CS Voicestack) via an edit qualifies this
    // submission for an integration ticket just as much as one specified at creation — auto-start
    // it the same way, never something anyone has to remember to do by hand.
    if (!submission.integrationTicketCreatedAt && needsIntegration(submission)) {
      submission.integrationStatus = 'Needle Request (OneApi Cred)'
      submission.integrationTicketCreatedAt = new Date()
      entries.push({
        action: 'submission.integration_ticket_created',
        summary: `Integration ticket created (PMS: ${submission.pms})`,
      })
    }

    // Reaching Completed is the one integration-status change worth its own timestamp — drives
    // the "integration complete" notification to the POC, same pattern as qaHandoffAt below.
    if (updates.integrationStatus !== undefined && normalizeStatus(updates.integrationStatus) === 'COMPLETED') {
      submission.integrationCompletedAt = new Date()
    }

    await submission.save()
    res.json(submission)

    logSubmissionAuditEntries(entries, { req, submission })

    updateSubmissionRow(submission).catch((err) => {
      req.log.error({ err, submissionId: submission._id }, 'Failed to sync submission edit to Google Sheet')
    })

    for (const field of MANUAL_TRACKING_FIELDS) {
      if (updates[field] === undefined) continue
      setManualField(submission, field, submission[field]).catch((err) => {
        req.log.error({ err, submissionId: submission._id, field }, 'Failed to sync field to Google Sheet')
      })
    }

    // Both the QA-handoff note and the QA-result message are composed by whoever triggers the
    // transition (specialist / QA) and only sent if they actually wrote one — a recheck reopening
    // back to QA (isRecheck) is silent, since the specialist already got the original handoff
    // message and doesn't need a second "ready for QA" ping for the same round.
    if (updates.configurationStatus !== undefined) {
      const newStatus = normalizeStatus(updates.configurationStatus)
      if (newStatus === 'QA' && !req.body.isRecheck && req.body.qaHandoffMessage && req.body.qaHandoffMessage.trim()) {
        postToQaGroup(req.body.qaHandoffMessage.trim()).catch((err) => req.log.error({ err, submissionId: submission._id }, 'Failed to notify QA team in Chat'))
        // Drives the "new QA request" notification badge/sound — a genuine handoff only (see the
        // qaHandoffMessage condition above), not QA resuming their own on-hold review or a recheck.
        submission.qaHandoffAt = new Date()
        submission.save().catch((err) => req.log.error({ err, submissionId: submission._id }, 'Failed to stamp qaHandoffAt'))
      } else if (newStatus === 'COMPLETED' && req.body.qaResultMessage && req.body.qaResultMessage.trim()) {
        postToQaGroup(req.body.qaResultMessage.trim()).catch((err) => req.log.error({ err, submissionId: submission._id }, 'Failed to send QA result to Chat'))
      }
    }
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

// A deliberate, separate step from marking Completed — QA may want to hold off telling the
// client right away, and may go through one or more recheck rounds first. QA/admin only, same
// as the rest of the QA-side actions.
exports.handover = async (req, res, next) => {
  try {
    if (!['qa', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const message = (req.body.message || '').trim()
    if (!message) return res.status(400).json({ error: 'Message is required' })

    const submission = await Submission.findById(req.params.id)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })
    if (submission.qaAgent && !isMineName(submission.qaAgent, req.user.name)) {
      return res.status(403).json({ error: 'Only the QA agent who reviewed this can hand it over' })
    }

    submission.pocHandoverAt = new Date()
    await submission.save()
    res.json(submission)

    logAction({
      actor: req.user,
      action: 'submission.handover',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: 'Handed over to POC',
    })

    // The message is composed with a literal "<users/all>" placeholder (see the frontend's
    // startHandover) since the sender has no way to know the POC's Chat ID themselves — swapped
    // here for a real per-person mention when we have one on file for this specific submission's
    // owner, so the actual POC gets pinged instead of the whole space. Falls back to @all
    // untouched if that POC's Chat ID was never captured (see AdminUsers.jsx > Manage Access).
    submission
      .populate('owner', 'chatUserId')
      .then((populated) => {
        const chatUserId = populated.owner?.chatUserId
        const toSend = chatUserId ? message.replace('<users/all>', `<users/${chatUserId}>`) : message
        return postToPocGroup(toSend)
      })
      .catch((err) => req.log.error({ err, submissionId: submission._id }, 'Failed to send handover message to Chat'))
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    next(err)
  }
}

// Same staff roster GET /agents draws from — @-mentions only ever resolve against these roles,
// never a POC (a POC mentioning another POC makes no sense here, and there's no cross-POC
// visibility to support it anyway).
const MENTIONABLE_ROLES = ['qa', 'specialist', 'admin']

// Matches "@Name" substrings in a comment's text against the staff roster and returns the
// matched users' ids, for the comment's `mentions` array. Sorted longest-name-first so e.g.
// "@Jo Smith" doesn't get shadowed by a shorter "@Jo" also being on the roster. Best-effort and
// intentionally simple (plain substring match, no markup) — matches the "don't over-engineer
// this part" scope of the feature.
async function resolveMentions(text) {
  if (!text || !text.includes('@')) return []
  const staff = await User.find({ role: { $in: MENTIONABLE_ROLES } }).select('name')
  return staff
    .filter((u) => u.name && text.includes(`@${u.name}`))
    .sort((a, b) => b.name.length - a.name.length)
    .map((u) => u._id)
}

// A Sheets-comment-style discussion thread — anyone who can configure this account (specialist/
// qa/admin) or the POC who owns it can post; everyone with access to the submission can read the
// whole log. Notification is thread-relative rather than tied to a fixed role: a staff post
// always notifies the POC, while a POC's reply notifies whichever staff member posted most
// recently (not necessarily the current specialist/qaAgent, since anyone on the team can weigh in).
exports.addComment = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    const isStaffAuthor = ['specialist', 'qa', 'admin'].includes(req.user.role)
    let notifyUserId = null
    if (isStaffAuthor) {
      notifyUserId = submission.owner
    } else {
      const lastStaffComment = [...submission.comments].reverse().find((c) => c.authorRole !== 'poc')
      notifyUserId = lastStaffComment ? lastStaffComment.authorId : null
    }

    const text = req.body.text.trim()
    const section = (req.body.section || '').trim() || null
    const mentions = await resolveMentions(text)
    submission.comments.push({
      authorId: req.user._id,
      authorName: req.user.name,
      authorRole: req.user.role,
      text,
      section,
      notifyUserId,
      mentions,
    })
    await submission.save()
    res.status(201).json(submission)

    logAction({
      actor: req.user,
      action: 'submission.comment',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: `Commented: "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`,
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

// A comment's own author can edit its text later (unrestricted — no time window, this is a
// low-stakes internal tool and nothing else in the codebase establishes an edit-window pattern
// worth mirroring here). Re-resolves @-mentions against the new text same as addComment.
exports.editComment = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    const comment = submission.comments.id(req.params.commentId)
    if (!comment) return res.status(404).json({ error: 'Comment not found' })
    if (String(comment.authorId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'You can only edit your own comments' })
    }

    const text = req.body.text.trim()
    comment.text = text
    comment.editedAt = new Date()
    comment.mentions = await resolveMentions(text)
    await submission.save()
    res.json(submission)

    logAction({
      actor: req.user,
      action: 'submission.comment_edit',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: `Edited comment: "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`,
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

// The comment's own author OR an admin can delete it — same "admin can override anything"
// pattern as the rest of this controller (see e.g. create()'s group ownership check).
exports.deleteComment = async (req, res, next) => {
  try {
    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    const comment = submission.comments.id(req.params.commentId)
    if (!comment) return res.status(404).json({ error: 'Comment not found' })
    const isOwnComment = String(comment.authorId) === String(req.user._id)
    if (!isOwnComment && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own comments' })
    }

    submission.comments = submission.comments.filter((c) => String(c._id) !== String(req.params.commentId))
    await submission.save()
    res.json(submission)

    logAction({
      actor: req.user,
      action: 'submission.comment_delete',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: 'Deleted a comment',
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    next(err)
  }
}

// The primary template (frontend/public/phone-info-sheet-template.xlsx) is a two-tab workbook —
// Devices sheet, Agents sheet, see parseXlsxPhoneSheet below. A .csv upload is also still
// accepted, laid out as the same two tables stacked vertically instead of tabs (a Devices header +
// rows, one blank line, then an Agents header + rows) — no column ever shared between the two, and
// no Type column needed since which table a row belongs to is just which block it's in.
const PHONE_SHEET_DEVICE_HEADERS = {
  'device make': 'deviceMake',
  'device model': 'deviceModel',
  'mac address': 'mac',
  mac: 'mac',
  'serial number': 'serial',
  serial: 'serial',
  'ipui code': 'ipuiCode',
  ipui: 'ipuiCode',
  assignment: 'assignment',
  extension: 'extension',
  'hot desking': 'hotDesking',
}
const PHONE_SHEET_AGENT_HEADERS = {
  'agent name': 'name',
  name: 'name',
  'agent email': 'email',
  email: 'email',
  'admin user': 'isAdminUser',
  extension: 'extension',
  'hot desking user': 'hotDeskingUser',
  'fax access': 'faxAccess',
}
const PHONE_SHEET_BOOLEAN_FIELDS = new Set(['hotDesking', 'isAdminUser', 'hotDeskingUser', 'faxAccess'])

function coerceBooleans(row) {
  const out = { ...row }
  for (const key of Object.keys(out)) {
    if (PHONE_SHEET_BOOLEAN_FIELDS.has(key)) out[key] = parseCsvBoolean(out[key])
  }
  return out
}

function parsePhoneSheetCsv(buffer) {
  const [devicesBlock, agentsBlock] = splitCsvSections(buffer.toString('utf8'))
  const devices = devicesBlock ? parseCsv(devicesBlock, PHONE_SHEET_DEVICE_HEADERS).map(coerceBooleans) : []
  const agents = agentsBlock ? parseCsv(agentsBlock, PHONE_SHEET_AGENT_HEADERS).map(coerceBooleans) : []
  return { devices, agents }
}

// The .xlsx counterpart to the CSV template — a proper two-tab workbook (Devices sheet, Agents
// sheet) instead of the blank-line-separated stack, since a real spreadsheet already has tabs for
// exactly this. Sheet lookup is by name (case-insensitive) with a positional fallback (1st/2nd
// sheet) in case someone renamed a tab. sheet_to_json({header: 1}) returns each row as a plain
// array of cells, same shape parseCsvLine produces, so it goes through the same mapTableRows the
// CSV path uses — one set of header-name rules for both formats.
function parseXlsxPhoneSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const findSheet = (name, fallbackIndex) => {
    const sheetName = workbook.SheetNames.find((n) => n.trim().toLowerCase() === name) || workbook.SheetNames[fallbackIndex]
    return sheetName ? workbook.Sheets[sheetName] : null
  }
  const toRows = (sheet) => (sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) : [])

  const devices = mapTableRows(toRows(findSheet('devices', 0)), PHONE_SHEET_DEVICE_HEADERS).map(coerceBooleans)
  const agents = mapTableRows(toRows(findSheet('agents', 1)), PHONE_SHEET_AGENT_HEADERS).map(coerceBooleans)
  return { devices, agents }
}

function parsePhoneSheetFile(file) {
  const isXlsx = /\.xlsx?$/i.test(file.originalname)
  return isXlsx ? parseXlsxPhoneSheet(file.buffer) : parsePhoneSheetCsv(file.buffer)
}

// Test feature — stateless, no submission id needed: lets the wizard parse the combined phone
// sheet (CSV or XLSX) before the location exists yet (staged client-side like any other Step 6
// field, submitted with the rest on Submit). Nothing saved here, just the same parsing
// uploadPhoneSheet below uses on an existing submission.
exports.parsePhoneSheet = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })
    res.json(parsePhoneSheetFile(req.file))
  } catch (err) {
    next(err)
  }
}

// Test feature — the same upload (CSV or XLSX) for a submission that already exists, parsed and
// saved in one step. A full replacement of both arrays (not merged with what's already there),
// same "upload is a fresh snapshot" semantics as re-uploading a corrected file.
exports.uploadPhoneSheet = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    const { devices, agents } = parsePhoneSheetFile(req.file)
    submission.phoneSheetDevices = devices
    submission.phoneSheetAgents = agents
    await submission.save()
    res.json(submission)

    logAction({
      actor: req.user,
      action: 'submission.phone_sheet_upload',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: `Uploaded phone info sheet (${devices.length} device row(s), ${agents.length} agent row(s))`,
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const submission = await Submission.findOne(filter)
    if (!submission) return res.status(404).json({ error: 'Submission not found' })

    await Submission.deleteOne({ _id: submission._id })
    res.status(204).end()

    logAction({
      actor: req.user,
      action: 'submission.delete',
      targetType: 'Submission',
      targetId: submission._id,
      targetLabel: submissionLabel(submission),
      summary: 'Deleted location',
    })

    deleteSubmissionRow(submission).catch((err) => {
      req.log.error({ err, submissionId: submission._id }, 'Failed to delete submission row from Google Sheet')
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid submission id' })
    next(err)
  }
}
