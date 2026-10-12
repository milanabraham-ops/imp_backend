const Group = require('../models/Group')
const Submission = require('../models/Submission')
const { deleteSubmissionRow } = require('../services/sheetSync')
const { attachManualStatus } = require('../utils/manualStatus')
const { normalizeStatus, statusEquals } = require('../utils/statusMatch')
const { logAction } = require('../utils/auditLog')

// Groups belong to the client relationship, same as submissions — only POC (own) or Admin (any)
// can create/rename/delete one. Specialist/QA get read-only visibility, same as their submission access.
const OWNER_ROLES = ['poc', 'admin']

function uniqueValues(list, key) {
  return [...new Set(list.map((l) => l[key]).filter(Boolean))]
}

// Accepts the raw request value for expectedLocationCount and returns either a positive integer,
// null (explicitly cleared), or undefined (not provided at all — leave existing value untouched).
// Throws a string error message on an invalid non-empty value.
function parseExpectedLocationCount(raw) {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error('Expected location count must be a positive whole number')
  return n
}

// Configuration Status pipeline in the Sheet is: Not Taken -> Not Started -> In Progress -> QA ->
// Completed, with On Hold a pause reachable from either In Progress or QA. A group's locations
// tend to move through the pipeline together, so roll them up into a single group-level status
// using whichever location is furthest behind: blank/Not Started until at least one location has
// actually been taken past that (someone's touched it), "In Progress" from there until every
// location has at least reached QA, "QA" until every location is Completed, and "Completed" only
// once all of them are. Casing in the Sheet isn't meaningful (QA / qa / Qa are the same), so every
// lookup goes through normalizeStatus first.
const STATUS_TIER = { '': 0, 'NOT TAKEN': 0, 'NOT STARTED': 0, 'IN PROGRESS': 1, QA: 2, COMPLETED: 3 }

// On Hold carries no tier of its own — it's a pause on top of whichever stage it was paused
// from (statusBeforeHold), so the rollup treats a held location as still sitting at that stage.
function tierOf(loc) {
  const status = normalizeStatus(loc.configurationStatus)
  if (status === 'ON HOLD') return normalizeStatus(loc.statusBeforeHold) === 'QA' ? 2 : 1
  return STATUS_TIER[status] ?? 0
}

function rollupConfigurationStatus(locs) {
  if (locs.length === 0) return ''
  const minTier = Math.min(...locs.map(tierOf))
  if (minTier >= 3) return 'Completed'
  if (minTier >= 2) return 'QA'
  if (minTier >= 1) return 'In Progress'
  return ''
}

// Unlike Configuration Status, Account Onboarded is a property of the client account as a whole,
// not each individual location — the account only goes through onboarding once. So once any one
// location has been closed out, the group stays "onboarded" from then on, even as further
// locations are added later (they inherit the account's already-onboarded state).
//
// Blank stays blank: a location's own accountOnboarded is '' until someone actually sets it, and
// the rollup mirrors that — it must not default every fresh group to "Open" just because nothing
// is "Closed" yet, or every brand-new group would misleadingly read as already in onboarding.
function rollupAccountOnboarded(locs) {
  if (locs.some((l) => statusEquals(l.accountOnboarded, 'CLOSED'))) return 'Closed'
  if (locs.some((l) => statusEquals(l.accountOnboarded, 'OPEN'))) return 'Open'
  return ''
}

// Integration is a separate tracking dimension from Configuration Status (see submissionController's
// needsIntegration) — only locations with a non-CS-Voicestack environment and a PMS specified ever
// get an integrationStatus at all, so the rollup only ever considers those, not every location in
// the group. A group with none of its locations needing integration has no rollup at all ('') and
// is meant to be filtered out of the Integrations view entirely — see needsIntegration below.
const INTEGRATION_STATUS_TIER = {
  'NEEDLE REQUEST (ONEAPI CRED)': 0,
  'ONEAPI SETUP & INTEGRATION PROCESS': 1,
  'L2 HANDOVER': 2,
  COMPLETED: 3,
}
const INTEGRATION_STATUS_LABELS = ['Needle Request (OneApi Cred)', 'OneAPI Setup & Integration Process', 'L2 Handover', 'Completed']

function rollupIntegrationStatus(locs) {
  const relevant = locs.filter((l) => l.integrationStatus)
  if (relevant.length === 0) return ''
  const minTier = Math.min(...relevant.map((l) => INTEGRATION_STATUS_TIER[normalizeStatus(l.integrationStatus)] ?? 0))
  return INTEGRATION_STATUS_LABELS[minTier]
}

exports.create = async (req, res, next) => {
  try {
    if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const clientName = (req.body.clientName || '').trim()
    if (!clientName) return res.status(400).json({ error: 'Client name is required' })

    let expectedLocationCount
    try {
      expectedLocationCount = parseExpectedLocationCount(req.body.expectedLocationCount) ?? null
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const group = await Group.create({
      clientName,
      owner: req.user._id,
      expectedLocationCount,
      isTestData: Boolean(req.user.isTestAccount),
    })
    res.status(201).json(group)

    logAction({
      actor: req.user,
      action: 'group.create',
      targetType: 'Group',
      targetId: group._id,
      targetLabel: group.clientName,
      summary: 'Created a multi-location group',
    })
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

exports.list = async (req, res, next) => {
  try {
    const isOwnerScoped = req.user.role === 'poc'
    const groupFilter = isOwnerScoped ? { owner: req.user._id } : {}
    const locationFilter = isOwnerScoped ? { owner: req.user._id, group: { $ne: null } } : { group: { $ne: null } }

    const groups = await Group.find(groupFilter).sort({ createdAt: -1 })
    const locations = await Submission.find(locationFilter)
    const merged = await attachManualStatus(Submission, locations)

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const byGroup = new Map()
    for (const loc of merged) {
      const gid = String(loc.group)
      if (!byGroup.has(gid)) byGroup.set(gid, [])
      byGroup.get(gid).push(loc)
    }

    res.json(
      groups.map((g) => {
        const locs = byGroup.get(String(g._id)) || []
        const mostRecent = locs.reduce((latest, l) => (!latest || new Date(l.createdAt) > new Date(latest) ? l.createdAt : latest), null)
        // Rolled up the same way as mostRecentLocationAt — drives the POC handover notification
        // for grouped locations, since GET /submissions deliberately excludes them (group: null).
        const mostRecentHandover = locs.reduce(
          (latest, l) => (l.pocHandoverAt && (!latest || new Date(l.pocHandoverAt) > new Date(latest)) ? l.pocHandoverAt : latest),
          null,
        )
        const integrationLocs = locs.filter((l) => l.integrationStatus)
        return {
          ...g.toObject(),
          locationCount: locs.length,
          mostRecentLocationAt: mostRecent,
          mostRecentHandoverAt: mostRecentHandover,
          locationsThisMonth: locs.filter((l) => new Date(l.createdAt) >= startOfMonth).length,
          specialists: uniqueValues(locs, 'implementationSpecialist'),
          qaAgents: uniqueValues(locs, 'qaAgent'),
          markets: uniqueValues(locs, 'market'),
          pocs: uniqueValues(locs, 'poc'),
          configurationStatus: rollupConfigurationStatus(locs),
          accountOnboarded: rollupAccountOnboarded(locs),
          // Integration is shown as its own separate double-pipeline (see IntegrationBoard/
          // IntegrationGroupDetail on the frontend) — these fields drive that view only.
          needsIntegration: integrationLocs.length > 0,
          integrationLocationCount: integrationLocs.length,
          integrationStatus: rollupIntegrationStatus(locs),
          integrationAgents: uniqueValues(locs, 'integrationAgent'),
          pmsSystems: uniqueValues(integrationLocs, 'pms'),
        }
      }),
    )
  } catch (err) {
    next(err)
  }
}

exports.getById = async (req, res, next) => {
  try {
    const isOwnerScoped = req.user.role === 'poc'
    const groupFilter = isOwnerScoped ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const group = await Group.findOne(groupFilter)
    if (!group) return res.status(404).json({ error: 'Group not found' })

    const locationFilter = isOwnerScoped
      ? { group: group._id, owner: req.user._id }
      : { group: group._id }
    const locations = await Submission.find(locationFilter).sort({ createdAt: -1 })
    const merged = await attachManualStatus(Submission, locations)
    res.json({ ...group.toObject(), locations: merged })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid group id' })
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const group = await Group.findOne(filter)
    if (!group) return res.status(404).json({ error: 'Group not found' })

    const prevClientName = group.clientName

    if (req.body.clientName !== undefined) {
      const clientName = req.body.clientName.trim()
      if (!clientName) return res.status(400).json({ error: 'Client name is required' })
      group.clientName = clientName
    }

    if (req.body.expectedLocationCount !== undefined) {
      try {
        group.expectedLocationCount = parseExpectedLocationCount(req.body.expectedLocationCount)
      } catch (err) {
        return res.status(400).json({ error: err.message })
      }
    }

    await group.save()
    res.json(group)

    if (group.clientName !== prevClientName) {
      logAction({
        actor: req.user,
        action: 'group.rename',
        targetType: 'Group',
        targetId: group._id,
        targetLabel: group.clientName,
        summary: `Renamed group from "${prevClientName}" to "${group.clientName}"`,
      })
    }
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid group id' })
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })

    const filter = req.user.role === 'poc' ? { _id: req.params.id, owner: req.user._id } : { _id: req.params.id }
    const group = await Group.findOne(filter)
    if (!group) return res.status(404).json({ error: 'Group not found' })

    const locationFilter = req.user.role === 'poc' ? { group: group._id, owner: req.user._id } : { group: group._id }
    const locations = await Submission.find(locationFilter)
    await Submission.deleteMany(locationFilter)
    await Group.deleteOne({ _id: group._id })
    res.status(204).end()

    logAction({
      actor: req.user,
      action: 'group.delete',
      targetType: 'Group',
      targetId: group._id,
      targetLabel: group.clientName,
      summary: `Deleted group and its ${locations.length} location${locations.length === 1 ? '' : 's'}`,
    })

    Promise.allSettled(locations.map((s) => deleteSubmissionRow(s))).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          req.log.error({ err: r.reason, submissionId: locations[i]._id }, 'Failed to delete location row from Google Sheet')
        }
      })
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid group id' })
    next(err)
  }
}
