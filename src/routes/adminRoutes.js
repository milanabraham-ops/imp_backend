const router = require('express').Router()
const ctrl = require('../controllers/adminController')
const settingsCtrl = require('../controllers/settingsController')
const testDataCtrl = require('../controllers/testDataController')
const requireAuth = require('../middleware/requireAuth')
const requireRole = require('../middleware/requireRole')
const { validateBody } = require('../middleware/validate')
const { createUserSchema } = require('../validators/adminValidators')

router.use(requireAuth, requireRole('admin'))

router.get('/users', ctrl.listUsers)
router.post('/users', validateBody(createUserSchema), ctrl.createUser)
router.patch('/users/:id/role', ctrl.updateRole)
router.patch('/users/:id/chat-id', ctrl.updateChatUserId)
router.post('/users/:id/reset-password', ctrl.resetPassword)
router.delete('/users/:id', ctrl.removeUser)

router.get('/settings', settingsCtrl.get)
router.patch('/settings', settingsCtrl.update)

router.post('/purge-test-data', testDataCtrl.purge)

module.exports = router
