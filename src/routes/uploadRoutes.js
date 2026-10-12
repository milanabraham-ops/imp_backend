const router = require('express').Router()
const multer = require('multer')
const ctrl = require('../controllers/uploadController')
const requireAuth = require('../middleware/requireAuth')
const requireAuthStreaming = require('../middleware/requireAuthStreaming')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) {
      const err = new Error('Only audio files are allowed')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

router.post('/', requireAuth, upload.single('file'), ctrl.upload)
router.get('/:id', requireAuthStreaming, ctrl.stream)
router.delete('/:id', requireAuth, ctrl.remove)

module.exports = router
