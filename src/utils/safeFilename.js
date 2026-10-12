// Neither GridFS nor the Google Drive API ever use this filename as an actual filesystem path —
// it's just a display attribute — so the real risk from a raw client-supplied filename isn't path
// traversal, it's a crafted name breaking out of the Content-Disposition header (quotes, CRLF) or
// otherwise corrupting display. Strips those characters instead of discarding the readable name
// entirely, since the Drive folder is meant to stay human-browsable by filename.
function sanitizeFilename(name) {
  const cleaned = (name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return cleaned.slice(0, 200) || 'file'
}

module.exports = { sanitizeFilename }
