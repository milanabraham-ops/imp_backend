const Submission = require('../models/Submission')
const Group = require('../models/Group')

// Minimal-field projection powering NotificationContext's poll (every open tab, every 5s) — the
// full submission/group documents it used to fetch (GET /submissions + GET /groups) carry a lot
// nothing here looks at: serverAccess (encrypted PMS creds), phoneSheetDevices/Agents, full
// comment text/author, forwardingNumbers, etc. Same role-based scoping as those two endpoints,
// just projected down to the handful of fields relevantEvents() in NotificationContext.jsx
// actually reads.
const SUBMISSION_FIELDS =
  'clientName locationName poc createdAt qaHandoffAt pocHandoverAt lastPocEditAt lastPocEditSummary ' +
  'integrationTicketCreatedAt pms integrationCompletedAt comments.notifyUserId comments.mentions comments.createdAt comments.section'

exports.feed = async (req, res, next) => {
  try {
    const isPoc = req.user.role === 'poc'

    const submissionFilter = isPoc ? { owner: req.user._id, group: null } : {}
    const submissions = await Submission.find(submissionFilter).select(SUBMISSION_FIELDS).lean()

    // Only these roles ever look at groups' mostRecentHandoverAt (see relevantEvents) — skip the
    // extra queries entirely for specialist/qa.
    const wantsGroups = ['poc', 'admin'].includes(req.user.role)
    let groups = []
    if (wantsGroups) {
      const groupFilter = isPoc ? { owner: req.user._id } : {}
      const locationFilter = isPoc ? { owner: req.user._id, group: { $ne: null } } : { group: { $ne: null } }
      const [groupDocs, locations] = await Promise.all([
        Group.find(groupFilter).select('clientName').lean(),
        Submission.find(locationFilter).select('group pocHandoverAt').lean(),
      ])

      const byGroup = new Map()
      for (const loc of locations) {
        const gid = String(loc.group)
        if (!byGroup.has(gid)) byGroup.set(gid, [])
        byGroup.get(gid).push(loc)
      }

      // Same rollup as groupController.list's mostRecentHandoverAt — recomputed here rather than
      // shared, since that function also does a lot this feed doesn't need (status tiers,
      // specialist/QA rollups, integration fields).
      groups = groupDocs.map((g) => {
        const locs = byGroup.get(String(g._id)) || []
        const mostRecentHandoverAt = locs.reduce(
          (latest, l) => (l.pocHandoverAt && (!latest || new Date(l.pocHandoverAt) > new Date(latest)) ? l.pocHandoverAt : latest),
          null,
        )
        return { _id: g._id, clientName: g.clientName, mostRecentHandoverAt }
      })
    }

    res.json({ submissions, groups })
  } catch (err) {
    next(err)
  }
}
