const router = require('express').Router()
const ctrl = require('../controllers/notificationController')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)
router.get('/feed', ctrl.feed)

module.exports = router
