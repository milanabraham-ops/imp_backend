const isProd = process.env.NODE_ENV === 'production'

const REFRESH_COOKIE_NAME = 'refreshToken'
const CSRF_COOKIE_NAME = 'csrfToken'

// SameSite=None is required for a cookie to be sent at all on cross-site requests — frontend
// (Vercel) and backend (Render) live on different domains in production — and browsers require
// Secure whenever SameSite=None is used. In local dev, frontend/backend are both plain
// http://localhost, so Secure would silently block the cookie entirely; Lax without Secure is
// the dev-mode equivalent that still works over plain HTTP.
function baseCookieOptions() {
  return {
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/auth',
  }
}

function refreshCookieOptions() {
  return { ...baseCookieOptions(), httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}

// Deliberately NOT HttpOnly — the frontend needs to read this out of document.cookie and echo it
// back as a header on refresh/logout requests (the CSRF "double-submit" check, see middleware/csrf.js).
// Path is '/' here, NOT '/api/auth' like the refresh cookie — a cookie's Path also gates whether
// document.cookie can see it at all, evaluated against the CURRENT PAGE's path. The frontend's
// own pages (/dashboard, /board, ...) never start with /api/auth, so scoping this cookie's path
// that way would make it invisible to the frontend JS that needs to read it, even though the
// browser would still correctly attach it to the actual /api/auth/* request.
function csrfCookieOptions() {
  return { ...baseCookieOptions(), path: '/', httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}

module.exports = { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME, refreshCookieOptions, csrfCookieOptions }
