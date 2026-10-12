const { verifyAccessToken } = require('../utils/jwt')
const User = require('../models/User')

module.exports = async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
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
