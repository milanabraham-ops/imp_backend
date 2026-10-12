const router = require('express').Router()
const multer = require('multer')
const ctrl = require('../controllers/avatarUploadController')
const requireAuth = require('../middleware/requireAuth')
const requireAuthStreaming = require('../middleware/requireAuthStreaming')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      const err = new Error('Only image files are allowed')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

router.post('/', requireAuth, upload.single('file'), ctrl.upload)
router.get('/file/:id', requireAuthStreaming, ctrl.stream)

module.exports = router
