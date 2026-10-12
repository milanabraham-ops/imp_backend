const router = require('express').Router()
const multer = require('multer')
const ctrl = require('../controllers/submissionController')
const requireAuth = require('../middleware/requireAuth')
const { validateBody } = require('../middleware/validate')
const { createSubmissionSchema, updateSubmissionSchema, addCommentSchema } = require('../validators/submissionValidators')

const phoneSheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(csv|xlsx?)$/i.test(file.originalname)) {
      const err = new Error('Only .csv or .xlsx/.xls files are supported.')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

router.use(requireAuth)

router.post('/', validateBody(createSubmissionSchema), ctrl.create)
router.get('/', ctrl.list)
router.get('/:id', ctrl.getById)
router.patch('/:id', validateBody(updateSubmissionSchema), ctrl.update)
router.post('/:id/handover', ctrl.handover)
router.post('/:id/retry-sync', ctrl.retrySync)
router.post('/:id/comments', validateBody(addCommentSchema), ctrl.addComment)
router.patch('/:id/comments/:commentId', validateBody(addCommentSchema), ctrl.editComment)
router.delete('/:id/comments/:commentId', ctrl.deleteComment)
router.post('/phone-sheet/parse', phoneSheetUpload.single('file'), ctrl.parsePhoneSheet)
router.post('/:id/phone-sheet/upload', phoneSheetUpload.single('file'), ctrl.uploadPhoneSheet)
router.delete('/:id', ctrl.remove)

module.exports = router
