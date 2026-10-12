const router = require('express').Router()
const ctrl = require('../controllers/statsController')
const requireAuth = require('../middleware/requireAuth')

router.get('/', requireAuth, ctrl.get)
router.get('/export', requireAuth, ctrl.exportCsv)

module.exports = router
