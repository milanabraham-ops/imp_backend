const mongoose = require('mongoose')
const { getBucket } = require('../config/gridfs')
const { getClient: getDriveClient } = require('../config/googleDrive')
const { uploadToDrive, isConfigured: isDriveConfigured } = require('../services/driveUpload')
const { sanitizeFilename } = require('../utils/safeFilename')

// Drive is the primary store for audio uploads — GridFS is only used when Drive isn't
// configured at all (local/dev without a service account, or no folder set yet in Settings).
// uploadToDrive() itself returns null in exactly that case; anything else it does (a thrown
// error) means Drive IS configured but the upload failed, which should surface as an error
// instead of silently falling back to GridFS and quietly refilling Mongo.
exports.upload = async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })

  const filename = sanitizeFilename(req.file.originalname)

  try {
    const drive = await uploadToDrive(req.file.buffer, filename, req.file.mimetype, req.body.practiceName, req.body.locationName)
    if (drive) {
      return res.status(201).json({
        driveFileId: drive.fileId,
        filename,
        contentType: req.file.mimetype,
        size: req.file.size,
        driveUrl: drive.url,
      })
    }
  } catch (err) {
    req.log.error({ err }, 'Drive upload failed')
    return res.status(502).json({ error: 'Failed to upload file. Please try again.' })
  }

  try {
    const bucket = getBucket()
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype,
    })

    uploadStream.on('error', next)
    uploadStream.on('finish', () => {
      res.status(201).json({
        fileId: uploadStream.id,
        filename,
        contentType: req.file.mimetype,
        size: req.file.size,
        driveUrl: '',
      })
    })

    uploadStream.end(req.file.buffer)
  } catch (err) {
    next(err)
  }
}

// GridFS-only — used solely to serve files uploaded through the dev fallback path above.
// Drive-stored files are linked directly via their own driveUrl instead of going through here.
exports.stream = async (req, res, next) => {
  const { id } = req.params
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Invalid file id' })

  try {
    const bucket = getBucket()
    const _id = new mongoose.Types.ObjectId(id)
    const files = await bucket.find({ _id }).toArray()
    if (!files.length) return res.status(404).json({ error: 'File not found' })

    const file = files[0]
    res.set('Content-Type', file.contentType || 'application/octet-stream')
    res.set('Content-Disposition', `inline; filename="${sanitizeFilename(file.filename)}"`)
    res.set('Content-Length', file.length)

    bucket.openDownloadStream(_id).on('error', next).pipe(res)
  } catch (err) {
    next(err)
  }
}

// Accepts either a GridFS ObjectId (dev-fallback files) or a Drive file id (everything else) —
// the two id formats never collide, so which store to delete from is unambiguous.
exports.remove = async (req, res, next) => {
  const { id } = req.params

  try {
    if (mongoose.isValidObjectId(id)) {
      await getBucket().delete(new mongoose.Types.ObjectId(id))
      return res.status(204).end()
    }

    if (!(await isDriveConfigured())) return res.status(400).json({ error: 'Invalid file id' })
    await getDriveClient().files.delete({ fileId: id, supportsAllDrives: true })
    res.status(204).end()
  } catch (err) {
    if (err.message && /file not found/i.test(err.message)) {
      return res.status(404).json({ error: 'File not found' })
    }
    if (err.code === 404) return res.status(404).json({ error: 'File not found' })
    next(err)
  }
}
