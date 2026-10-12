const router = require('express').Router()
const ctrl = require('../controllers/pmsDocController')
const requireAuth = require('../middleware/requireAuth')
const requireRole = require('../middleware/requireRole')

router.get('/', requireAuth, ctrl.get)
router.post('/', requireAuth, requireRole('admin'), ctrl.upsert)
router.delete('/', requireAuth, requireRole('admin'), ctrl.remove)

module.exports = router
