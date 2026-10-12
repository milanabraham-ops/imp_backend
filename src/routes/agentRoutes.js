const router = require('express').Router()
const ctrl = require('../controllers/agentController')
const requireAuth = require('../middleware/requireAuth')
const requireRole = require('../middleware/requireRole')

// 'poc' included so CommentThread's @-mention autocomplete (which needs the staff name list) can
// load it from a POC's own submission view too — the data returned (name + role only) isn't
// sensitive, and a POC already sees staff names elsewhere on their own submission.
router.get('/', requireAuth, requireRole('qa', 'specialist', 'poc', 'admin'), ctrl.list)

module.exports = router
