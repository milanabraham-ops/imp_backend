const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const pinoHttp = require('pino-http')
const crypto = require('crypto')
const logger = require('./utils/logger')
const routes = require('./routes')
const errorHandler = require('./middleware/errorHandler')

const app = express()

// Render (like most PaaS platforms) puts exactly one reverse proxy in front of this process —
// without this, Express ignores X-Forwarded-For entirely, so req.ip/req.secure would both reflect
// the proxy itself, not the real client. That breaks two things silently: express-rate-limit keys
// everyone behind the proxy as the same IP (and, as of v7+, refuses to start at all once it sees
// X-Forwarded-For without a trust proxy setting — a real request would throw), and any per-IP
// logic in the audit trail would record the proxy's address for every request. Harmless locally —
// there's no proxy, so no X-Forwarded-For header ever arrives to trust in the first place.
app.set('trust proxy', 1)

// Every request gets its own child logger (req.log) carrying a correlation id, and one summary
// line logged automatically on completion (method, path, status, duration) — this is what makes
// "grep this one request's whole story" possible, instead of scattered, uncorrelated console
// lines. Health checks are excluded so Render's frequent polling doesn't drown out real traffic.
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || crypto.randomUUID()
      res.setHeader('X-Request-Id', id)
      return id
    },
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    // pino-http's default req/res serializers log the full raw headers object — confirmed this
    // means the live bearer access token and the refresh/CSRF session cookies get written out in
    // full on every single authenticated request/response otherwise. Redacted rather than dropped
    // entirely so the rest of the header (useful for debugging — content-type, origin, etc.) is
    // still there.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  }),
)

// Express sends this by default — no reason to advertise the framework to an attacker doing
// reconnaissance.
app.disable('x-powered-by')

app.use(
  helmet({
    // This is a JSON + file-streaming API consumed by a different-origin frontend (Vercel vs
    // Render) — Helmet's default Cross-Origin-Resource-Policy/Embedder-Policy are meant for
    // apps serving their own HTML+assets same-origin, and would otherwise block the frontend's
    // <img>/<a> requests for cross-origin avatar/audio files. CSP itself stays at Helmet's
    // default (default-src 'self') — harmless here since this server never renders HTML, but
    // kept as defense-in-depth for any future error/status page.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  }),
)

// No fallback to "allow everything" — an unset CORS_ORIGIN means no cross-origin browser request
// is allowed at all, rather than silently defaulting to a wildcard. credentials: true is required
// for the refresh/logout cookies to be sent cross-site; combined with a wildcard origin browsers
// would reject the response outright anyway, so this couldn't degrade to "open" even by mistake.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all (server-to-server calls, curl, health checks) — not a browser
      // cross-origin request, nothing to gate here.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
      callback(new Error('Not allowed by CORS'))
    },
    credentials: true,
  }),
)

app.use(cookieParser())
app.use(express.json({ limit: '2mb' }))
app.use('/api', routes)
app.use(errorHandler)

module.exports = app
