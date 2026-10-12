const crypto = require('crypto')
const { CSRF_COOKIE_NAME } = require('../utils/cookies')

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Double-submit cookie check — only needed on the two endpoints that rely on the refresh cookie
// (refresh, logout). Every other mutating endpoint in the app authenticates via the Authorization
// header instead of a cookie, and browsers never attach that header automatically to a cross-site
// request, so CSRF doesn't apply to those regardless.
//
// A cross-site attacker can make a victim's browser send the refresh cookie automatically, but
// same-origin policy stops the attacker's own script from reading its value — so it can't also
// set a matching X-CSRF-Token header, and this check rejects the forged request.
function requireCsrf(req, res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME]
  const headerToken = req.get('X-CSRF-Token')
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' })
  }
  next()
}

module.exports = { generateCsrfToken, requireCsrf }
