const crypto = require('crypto')
const { REFRESH_COOKIE_NAME } = require('../utils/cookies')
const { getRefreshSecret } = require('../utils/jwt')

// Derived from the refresh token's own signed string (HMAC'd with the same secret that signs it) ,
// never stored anywhere separately, so it's always automatically in sync with whichever refresh
// token is current, including across every rotation, with no extra state to keep paired.
//
// This replaced a classic double-submit cookie (a second, JS-readable cookie whose value had to
// match a header) that quietly never worked at all once the frontend (Vercel) and backend (Render)
// ended up on different domains: a cookie set by the backend's Set-Cookie response belongs to the
// backend's own origin, and document.cookie on the frontend's pages can never read a cookie that
// isn't theirs, no matter what SameSite/Path is set to. The header always came back empty, so every
// refresh/logout call failed this check in production, every page reload silently logged people
// out. Deriving the expected value from the httpOnly refresh cookie itself (which DOES always
// arrive correctly cross-origin, same as any httpOnly cookie) sidesteps the cross-origin read
// problem entirely: the frontend only ever needs to echo back a value it was handed directly in a
// response body (see authController's issueSession), not read it out of a cookie at all.
function deriveCsrfToken(refreshToken) {
  return crypto.createHmac('sha256', getRefreshSecret()).update(refreshToken).digest('hex')
}

// Only needed on the two endpoints that rely on the refresh cookie as their actual credential
// (refresh, logout). Every other mutating endpoint authenticates via the Authorization header
// instead of a cookie, and browsers never attach that header automatically to a cross-site
// request, so CSRF doesn't apply to those regardless.
//
// A cross-site attacker can make a victim's browser send the refresh cookie automatically, but has
// no way to know (or compute, without the server's secret) the matching X-CSRF-Token, so this
// still rejects a forged request exactly as a double-submit cookie would, just without needing a
// second cookie to do it.
function requireCsrf(req, res, next) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME]
  const headerToken = req.get('X-CSRF-Token')
  if (!refreshToken || !headerToken || deriveCsrfToken(refreshToken) !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' })
  }
  next()
}

module.exports = { deriveCsrfToken, requireCsrf }
