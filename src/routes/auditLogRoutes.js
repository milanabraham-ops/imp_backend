const router = require('express').Router()
const ctrl = require('../controllers/auditLogController')
const requireAuth = require('../middleware/requireAuth')
const requireRole = require('../middleware/requireRole')

router.use(requireAuth)

router.get('/', ctrl.list)
// Same auth/scoping as '/' (including the targetId ownership check for POC callers) — not
// admin-only, since exporting is just "the list, as a file" rather than a separate privilege.
router.get('/export', ctrl.export)
router.get('/archive', requireRole('admin'), ctrl.listArchive)

module.exports = router
