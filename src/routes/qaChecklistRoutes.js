const router = require('express').Router()
const ctrl = require('../controllers/qaChecklistController')
const requireAuth = require('../middleware/requireAuth')
const requireRole = require('../middleware/requireRole')

router.get('/', requireAuth, ctrl.get)
router.post('/', requireAuth, requireRole('qa', 'admin'), ctrl.addItem)
router.delete('/', requireAuth, requireRole('qa', 'admin'), ctrl.removeItem)
router.post('/base-items', requireAuth, requireRole('admin'), ctrl.addBaseItem)
router.delete('/base-items', requireAuth, requireRole('admin'), ctrl.removeBaseItem)

module.exports = router
