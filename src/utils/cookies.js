const isProd = process.env.NODE_ENV === 'production'

const REFRESH_COOKIE_NAME = 'refreshToken'

// SameSite=None is required for a cookie to be sent at all on cross-site requests — frontend
// (Vercel) and backend (Render) live on different domains in production — and browsers require
// Secure whenever SameSite=None is used. In local dev, frontend/backend are both plain
// http://localhost, so Secure would silently block the cookie entirely; Lax without Secure is
// the dev-mode equivalent that still works over plain HTTP.
function refreshCookieOptions() {
  return {
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/auth',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  }
}

// Matches how the old, now-unused JS-readable 'csrfToken' cookie used to be set (see
// authController's issueSession/clearSessionCookies) — kept only so a lingering copy from before
// that mechanism changed gets cleared on whoever's next login/refresh, rather than sitting there
// inert forever. Browsers need the attributes on a clear to match the ones it was set with.
function staleCsrfCookieOptions() {
  return { secure: isProd, sameSite: isProd ? 'none' : 'lax', path: '/' }
}

module.exports = { REFRESH_COOKIE_NAME, refreshCookieOptions, staleCsrfCookieOptions }
