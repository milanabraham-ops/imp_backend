const mongoose = require('mongoose')
const Submission = require('../models/Submission')
const Group = require('../models/Group')
const { getBucket } = require('../config/gridfs')
const { getClient: getDriveClient } = require('../config/googleDrive')
const { isConfigured: isDriveConfigured } = require('../services/driveUpload')
const { deleteSubmissionRow } = require('../services/sheetSync')

// Every place a submission can hold an uploaded audio file — the three top-level welcome/AHVM/BHVM
// files, plus each ring group's own on-hold and exit-queue files (exit/dq/qo, each with its own).
function fileRefsOf(submission) {
  const refs = [submission.welcomeFile, submission.ahvmFile, submission.bhvmFile]
  for (const group of submission.ringGroups || []) {
    for (const key of ['exit', 'dq', 'qo']) {
      const detail = group.queue?.[key]
      if (!detail) continue
      refs.push(detail.onholdFile, detail.exitFile)
    }
  }
  return refs.filter(Boolean)
}

// Wipes every account/location produced by test accounts — Mongo, the uploaded audio (GridFS),
// the Google Drive backup copies, and the corresponding Sheet rows — without touching anything
// created by a real account. Test accounts themselves are untouched so they stay reusable.
exports.purge = async (req, res, next) => {
  try {
    const submissions = await Submission.find({ isTestData: true })
    const bucket = getBucket()
    const drive = (await isDriveConfigured()) ? getDriveClient() : null

    // Flattened across every submission and run in parallel — same reasoning as the Sheet-row
    // deletion right below, which already did this. A purge covering a large batch of test
    // submissions was otherwise waiting on GridFS/Drive round-trips one file at a time.
    const allRefs = submissions.flatMap((s) => fileRefsOf(s))

    const gridfsRefs = allRefs.filter((ref) => ref.fileId)
    const gridfsResults = await Promise.allSettled(gridfsRefs.map((ref) => bucket.delete(new mongoose.Types.ObjectId(ref.fileId))))
    let filesDeleted = 0
    gridfsResults.forEach((r) => {
      if (r.status === 'fulfilled') filesDeleted++
      else if (!/file not found/i.test(r.reason?.message || '')) req.log.error({ err: r.reason }, 'Failed to delete GridFS file')
    })

    const driveRefs = drive ? allRefs.filter((ref) => ref.driveFileId) : []
    const driveResults = await Promise.allSettled(driveRefs.map((ref) => drive.files.delete({ fileId: ref.driveFileId, supportsAllDrives: true })))
    let driveFilesDeleted = 0
    driveResults.forEach((r) => {
      if (r.status === 'fulfilled') driveFilesDeleted++
      else req.log.error({ err: r.reason }, 'Failed to delete Drive file')
    })

    const sheetResults = await Promise.allSettled(submissions.map((s) => deleteSubmissionRow(s)))
    sheetResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        req.log.error({ err: r.reason, submissionId: submissions[i]._id }, 'Failed to delete test submission row from Google Sheet')
      }
    })

    const { deletedCount: submissionsDeleted } = await Submission.deleteMany({ isTestData: true })
    const { deletedCount: groupsDeleted } = await Group.deleteMany({ isTestData: true })

    res.json({ submissionsDeleted, groupsDeleted, filesDeleted, driveFilesDeleted })
  } catch (err) {
    next(err)
  }
}
