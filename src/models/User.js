const { Schema, model } = require('mongoose')

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String },
    googleId: { type: String },
    authProvider: { type: String, enum: ['local', 'google'], required: true },
    avatarUrl: { type: String, default: '' },
    role: { type: String, enum: ['poc', 'specialist', 'qa', 'admin'], default: 'poc' },
    // Set when an admin creates an account with the shared default password — forces a change on
    // first login before anything else in the app is reachable. Never true for Google sign-in
    // accounts, since those never have an admin-set password to begin with.
    mustChangePassword: { type: Boolean, default: false },
    // Full functionality, same as a real account — just tagged so its submissions/groups can be
    // told apart (isTestData) and bulk-purged later without touching real client data.
    isTestAccount: { type: Boolean, default: false },
    // Google Chat's numeric per-account ID (the number inside a <users/NUMBER> mention) — not an
    // email or anything derivable from one; each person's has to be looked up (Directory API,
    // People API, or a webhook <users/all> can't tell us) and entered here once. Lets chat
    // notifications @-mention this specific person instead of always pinging the whole space.
    chatUserId: { type: String, default: '', trim: true },
    // Account lockout — separate from authRateLimit (which is per-IP and resets every minute).
    // This is per-account and survives an attacker rotating IPs: failedLoginAttempts increments on
    // each wrong password and resets to 0 on a successful login; hitting the threshold sets
    // lockedUntil instead of just continuing to count, so a locked account stays locked for its
    // full window even if the attempts stop.
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    // Last few password hashes (most recent first, capped in authController), checked on change
    // so a user can't just cycle back to a password they used two changes ago. Never the *current*
    // passwordHash — that's checked separately (and with a clearer message) before this list is
    // even consulted.
    previousPasswordHashes: { type: [String], default: [] },
    // Per-device session tracking (what used to be a single refreshTokenVersion counter here)
    // now lives in its own Session collection — see models/Session.js for why.
  },
  { timestamps: true },
)

userSchema.index({ googleId: 1 }, { unique: true, sparse: true })

module.exports = model('User', userSchema)
