const { verifyAccessToken } = require('../utils/jwt')
const User = require('../models/User')

// Same check as requireAuth, but also accepts the access token via a ?token= query param.
// Needed specifically for <img src>/<a href> requests (avatar images, fallback audio links) —
// browsers never attach a custom Authorization header to a plain navigation or image load, so
// the header-only version can't protect these two routes. Everywhere else stays header-only.
module.exports = async function requireAuthStreaming(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token
  if (!token) return res.status(401).json({ error: 'Not authenticated' })

  try {
    const payload = verifyAccessToken(token)
    const user = await User.findById(payload.sub)
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' })
    req.user = user
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
