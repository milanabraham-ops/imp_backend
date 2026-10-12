const { getBucket } = require('../config/gridfs')
const { getClient: getDriveClient } = require('../config/googleDrive')
const { uploadAvatarToDrive, isConfigured: isDriveConfigured } = require('../services/driveUpload')
const { sanitizeFilename } = require('../utils/safeFilename')

// Same policy as audio uploads: Drive is primary, GridFS is only a fallback when Drive isn't
// configured at all. A configured-but-failing Drive call errors out rather than silently
// falling back, so a real outage stays visible instead of quietly refilling Mongo.
exports.upload = async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:5000'
  const filename = sanitizeFilename(req.file.originalname)

  try {
    const drive = await uploadAvatarToDrive(req.file.buffer, filename, req.file.mimetype)
    if (drive) {
      return res.status(201).json({ driveFileId: drive.fileId, url: `${base}/api/avatar/file/${drive.fileId}` })
    }
  } catch (err) {
    req.log.error({ err }, 'Drive avatar upload failed')
    return res.status(502).json({ error: 'Failed to upload photo. Please try again.' })
  }

  try {
    const bucket = getBucket()
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype,
    })
    uploadStream.on('error', next)
    uploadStream.on('finish', () => {
      res.status(201).json({ fileId: uploadStream.id, url: `${base}/api/uploads/${uploadStream.id}` })
    })
    uploadStream.end(req.file.buffer)
  } catch (err) {
    next(err)
  }
}

// Proxies a Drive-stored avatar back through our own origin so <img src> keeps working exactly
// like it did against GridFS — Drive's own webViewLink is an HTML viewer page, not a raw image
// URL, so it can't be used directly as an <img> source.
exports.stream = async (req, res, next) => {
  if (!(await isDriveConfigured())) return res.status(404).json({ error: 'File not found' })

  try {
    const drive = getDriveClient()
    const result = await drive.files.get(
      { fileId: req.params.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    )
    res.set('Content-Type', result.headers['content-type'] || 'application/octet-stream')
    result.data.on('error', next).pipe(res)
  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: 'File not found' })
    next(err)
  }
}
