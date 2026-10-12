const router = require('express').Router()
const { apiRateLimit } = require('../middleware/rateLimit')

// Before the rate limiter — infra health checks shouldn't ever be able to trip it.
router.get('/health', (req, res) => res.json({ status: 'ok' }))

router.use(apiRateLimit)

router.use('/auth', require('./authRoutes'))
router.use('/submissions', require('./submissionRoutes'))
router.use('/groups', require('./groupRoutes'))
router.use('/uploads', require('./uploadRoutes'))
router.use('/avatar', require('./avatarRoutes'))
router.use('/admin', require('./adminRoutes'))
router.use('/stats', require('./statsRoutes'))
router.use('/qa-checklist-items', require('./qaChecklistRoutes'))
router.use('/pms-docs', require('./pmsDocRoutes'))
router.use('/notifications', require('./notificationRoutes'))
router.use('/agents', require('./agentRoutes'))
router.use('/audit-logs', require('./auditLogRoutes'))

module.exports = router
