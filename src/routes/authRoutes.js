const router = require('express').Router()
const ctrl = require('../controllers/authController')
const requireAuth = require('../middleware/requireAuth')
const { requireCsrf } = require('../middleware/csrf')
const { authRateLimit } = require('../middleware/rateLimit')
const { validateBody } = require('../middleware/validate')
const { loginSchema, changePasswordSchema } = require('../validators/authValidators')

router.post('/login', authRateLimit, validateBody(loginSchema), ctrl.login)
router.post('/google', authRateLimit, ctrl.google)
// Both rely on the refresh cookie as their actual credential — CSRF-protected via the
// double-submit check instead of requireAuth, since the access token may already be expired by
// the time either of these is called (that's the normal case for refresh, and a valid reason to
// still allow logout).
router.post('/refresh', requireCsrf, ctrl.refresh)
router.post('/logout', requireCsrf, ctrl.logout)
router.get('/me', requireAuth, ctrl.me)
router.patch('/me', requireAuth, ctrl.updateMe)
router.post('/change-password', requireAuth, authRateLimit, validateBody(changePasswordSchema), ctrl.changePassword)
router.get('/sessions', requireAuth, ctrl.sessions)
router.post('/sessions/revoke-others', requireAuth, ctrl.revokeOtherSessions)
router.post('/sessions/:id/revoke', requireAuth, ctrl.revokeSession)

module.exports = router
