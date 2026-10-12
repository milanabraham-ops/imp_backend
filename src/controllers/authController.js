const bcrypt = require('bcryptjs')
const { OAuth2Client } = require('google-auth-library')
const User = require('../models/User')
const Session = require('../models/Session')
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt')
const { validatePassword } = require('../utils/passwordPolicy')
const { REFRESH_COOKIE_NAME, refreshCookieOptions, csrfCookieOptions } = require('../utils/cookies')
const { generateCsrfToken } = require('../middleware/csrf')

const googleClient = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID)

// Per-account lockout — complements authRateLimit (per-IP, resets every minute) with a check that
// survives an attacker rotating IPs. 5 wrong passwords locks the account for 15 minutes; the
// counter resets on any successful login.
const MAX_FAILED_ATTEMPTS = 5
const LOCK_DURATION_MS = 15 * 60 * 1000

function toPublicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl || '',
    role: user.role || 'poc',
    mustChangePassword: Boolean(user.mustChangePassword),
  }
}

// Starts (or renews) a session: sets the HttpOnly refresh cookie and a matching, JS-readable CSRF
// cookie (the frontend reads this straight out of document.cookie when it needs to echo it back
// as a header — no need to also carry it through the response body), and returns the short-lived
// access token + user payload. Every place a session actually begins or rotates (login, Google
// sign-in, refresh) goes through this so the cookie/token pairing can never drift out of sync.
// csrfToken used to be scoped to Path=/api/auth (a since-fixed bug — that made it invisible to
// document.cookie on the frontend's own pages). Browsers never overwrite a cookie set at a
// different Path, so anyone who logged in before the fix still has that stale copy sitting
// alongside the corrected one; browsers send the more specific path first, and the first one
// wins server-side, so the stale copy would otherwise keep beating the current one forever.
// Explicitly clearing the old path here self-heals every affected session on its next login.
function clearStaleCsrfCookie(res) {
  res.clearCookie('csrfToken', { path: '/api/auth' })
}

function issueSession(res, user, session) {
  res.cookie(REFRESH_COOKIE_NAME, signRefreshToken(session), refreshCookieOptions())
  clearStaleCsrfCookie(res)
  res.cookie('csrfToken', generateCsrfToken(), csrfCookieOptions())
  return { token: signAccessToken(user), user: toPublicUser(user) }
}

function clearSessionCookies(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions())
  res.clearCookie('csrfToken', csrfCookieOptions())
  clearStaleCsrfCookie(res)
}

// A brand-new device/browser logging in (login, Google sign-in) gets its own fresh Session
// document — never reuses or touches any other device's.
function createSession(req, user) {
  return Session.create({
    userId: user._id,
    userAgent: (req.headers['user-agent'] || '').slice(0, 300),
    ip: req.ip || '',
  })
}

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' })

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil - new Date()) / 60000))
      return res
        .status(423)
        .json({ error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      user.failedLoginAttempts += 1
      if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS)
        user.failedLoginAttempts = 0
      }
      await user.save()
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    user.failedLoginAttempts = 0
    user.lockedUntil = null
    await user.save()

    const session = await createSession(req, user)
    res.json(issueSession(res, user, session))
  } catch (err) {
    next(err)
  }
}

exports.google = async (req, res, next) => {
  try {
    const { credential } = req.body
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' })
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      return res.status(500).json({ error: 'Google sign-in is not configured on the server' })
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    if (!payload?.email) return res.status(401).json({ error: 'Invalid Google credential' })

    // Google sign-in never creates an account on its own — only an admin-added user (any
    // authProvider) can sign in this way, and only for the exact email an admin added.
    let user = await User.findOne({ googleId: payload.sub })
    if (!user) {
      user = await User.findOne({ email: payload.email.toLowerCase() })
      if (!user) return res.status(403).json({ error: 'No account found for this email. Ask an admin to add you first.' })
      user.googleId = payload.sub
      await user.save()
    }

    const session = await createSession(req, user)
    res.json(issueSession(res, user, session))
  } catch (err) {
    next(err)
  }
}

// Reads the HttpOnly refresh cookie, verifies it, and looks up the specific Session it names
// (`sid`) rather than a shared per-user counter — a mismatch on that session's own tokenVersion,
// or the session being revoked/gone, means this exact token was already rotated away (or that one
// device's session was deliberately ended) — rejecting it here is what makes reusing an old
// refresh token fail instead of silently minting another valid session from it, without that
// affecting any other device.
exports.refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME]
    if (!token) return res.status(401).json({ error: 'No refresh token' })

    let payload
    try {
      payload = verifyRefreshToken(token)
    } catch {
      clearSessionCookies(res)
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }

    const session = payload.sid ? await Session.findById(payload.sid) : null
    if (!session || session.revokedAt || session.tokenVersion !== payload.v || String(session.userId) !== payload.sub) {
      clearSessionCookies(res)
      return res.status(401).json({ error: 'Session no longer valid' })
    }

    const user = await User.findById(session.userId)
    if (!user) {
      clearSessionCookies(res)
      return res.status(401).json({ error: 'Session no longer valid' })
    }

    // Rotate — bump this session's own version so the token just presented can never be used
    // again, then issue a fresh refresh token embedding the same session id + new version. No
    // other session's version is touched.
    session.tokenVersion += 1
    session.lastUsedAt = new Date()
    session.ip = req.ip || session.ip
    await session.save()

    res.json(issueSession(res, user, session))
  } catch (err) {
    next(err)
  }
}

// Ends only THIS device's session (marks it revoked) — every other active session for the same
// account is untouched, unlike the old shared-counter scheme this replaced.
exports.logout = async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME]
    if (token) {
      try {
        const payload = verifyRefreshToken(token)
        if (payload.sid) await Session.updateOne({ _id: payload.sid }, { revokedAt: new Date() })
      } catch {
        // Already invalid/expired — nothing to invalidate, still clear cookies below.
      }
    }
    clearSessionCookies(res)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}

// Every session for this account, most-recently-used first — includes revoked ones? No: only
// active sessions are meaningful to show someone deciding what to sign out of. `current` marks
// whichever one the request's own refresh cookie names, so the frontend can label it and exclude
// it from "revoke" actions that only make sense for OTHER devices.
exports.sessions = async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME]
    let currentSid = null
    if (token) {
      try {
        currentSid = verifyRefreshToken(token).sid || null
      } catch {
        // Ignore — just means nothing gets marked "current" below.
      }
    }

    const sessions = await Session.find({ userId: req.user._id, revokedAt: null }).sort({ lastUsedAt: -1 }).lean()
    res.json(
      sessions.map((s) => ({
        id: s._id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        current: String(s._id) === String(currentSid),
      })),
    )
  } catch (err) {
    next(err)
  }
}

// Revokes one specific OTHER device's session — scoped to req.user's own sessions only, so
// nobody can end a session belonging to a different account by guessing its id. Revoking the
// CURRENT session here is refused (that's what /auth/logout is for, and it also clears this
// browser's own cookies, which this endpoint doesn't).
exports.revokeSession = async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME]
    let currentSid = null
    if (token) {
      try {
        currentSid = verifyRefreshToken(token).sid || null
      } catch {
        // Ignore.
      }
    }
    if (currentSid && String(currentSid) === String(req.params.id)) {
      return res.status(400).json({ error: 'Use logout to end your current session' })
    }

    const result = await Session.updateOne({ _id: req.params.id, userId: req.user._id, revokedAt: null }, { revokedAt: new Date() })
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Session not found' })
    res.status(204).end()
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid session id' })
    next(err)
  }
}

// "Log out everywhere else" — every active session for this account except whichever one the
// current request's own refresh cookie names.
exports.revokeOtherSessions = async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME]
    let currentSid = null
    if (token) {
      try {
        currentSid = verifyRefreshToken(token).sid || null
      } catch {
        // Ignore.
      }
    }

    const filter = { userId: req.user._id, revokedAt: null }
    if (currentSid) filter._id = { $ne: currentSid }
    const result = await Session.updateMany(filter, { revokedAt: new Date() })
    res.json({ revokedCount: result.modifiedCount || 0 })
  } catch (err) {
    next(err)
  }
}

exports.me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ user: toPublicUser(user) })
  } catch (err) {
    next(err)
  }
}

// Only path off the forced mustChangePassword state — requires the current password too (not
// just a valid session token) so a compromised/left-open session can't silently take over the
// account by changing the password without knowing it.
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body

    const policyError = validatePassword(newPassword)
    if (policyError) return res.status(400).json({ error: policyError })

    const user = await User.findById(req.user._id)
    if (!user || !user.passwordHash) return res.status(400).json({ error: 'Password change is not available for this account' })

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })

    const reused = await bcrypt.compare(newPassword, user.passwordHash)
    if (reused) return res.status(400).json({ error: 'New password must be different from your current password' })

    for (const oldHash of user.previousPasswordHashes) {
      if (await bcrypt.compare(newPassword, oldHash)) {
        return res.status(400).json({ error: "You've used that password before — please choose a new one" })
      }
    }

    // Most-recent-first, capped at the last 5 — enough to block "cycle back to what I just had"
    // without keeping an unbounded history of a user's password hashes forever.
    user.previousPasswordHashes = [user.passwordHash, ...user.previousPasswordHashes].slice(0, 5)
    user.passwordHash = await bcrypt.hash(newPassword, 10)
    user.mustChangePassword = false
    await user.save()

    // A password change should end every session on this account, on every device — revoke them
    // all, then issue a brand-new one for the current request right below.
    await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() })
    const session = await createSession(req, user)

    res.json(issueSession(res, user, session))
  } catch (err) {
    next(err)
  }
}

exports.updateMe = async (req, res, next) => {
  try {
    const { avatarUrl } = req.body
    if (typeof avatarUrl !== 'string') return res.status(400).json({ error: 'avatarUrl must be a string' })
    const trimmed = avatarUrl.trim()
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'avatarUrl must be a valid http(s) URL' })
    }

    const user = await User.findByIdAndUpdate(req.user._id, { avatarUrl: trimmed }, { new: true })
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ user: toPublicUser(user) })
  } catch (err) {
    next(err)
  }
}
