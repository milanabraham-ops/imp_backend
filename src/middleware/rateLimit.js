const rateLimit = require('express-rate-limit')

// 5 attempts per minute per IP — applied to the endpoints most valuable to brute-force (login,
// Google sign-in, change-password). Successful requests aren't counted, so a legitimate user's
// normal traffic never gets throttled by their own activity, only by repeated failures.
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again in a minute.' },
})

// Every other route had no rate limiting at all. This is a generous per-IP ceiling — high enough
// that normal usage (a handful of open tabs, each polling every 5s for notifications/board
// updates) never comes close, just enough to blunt a scripted scrape/abuse burst. Layered on top
// of, not instead of, authRateLimit's much stricter per-endpoint limit on login/change-password.
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
})

module.exports = { authRateLimit, apiRateLimit }
