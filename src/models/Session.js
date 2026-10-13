const { Schema, model } = require('mongoose')

// One document per device/browser that's ever logged in — replaces the old single
// refreshTokenVersion counter that used to live on User. That counter was shared across every
// device: rotating the refresh token on ONE device (which happens on ~every proactive refresh,
// not just re-login) bumped the one counter every device's token was checked against, so a second
// device would silently fail its next refresh and get logged out with no warning and no explicit
// action taken against it. Each refresh token now embeds this document's own _id (`sid`) and its
// own tokenVersion, so rotating one session never touches another, and each device can be listed/
// revoked individually (see authController exports.sessions/revokeSession/revokeOtherSessions).
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenVersion: { type: Number, default: 0 },
    // One rotation's worth of grace for reusing the just-rotated-out token (see authController's
    // refresh handler) — multiple tabs of the same browser share this one session/cookie, so two
    // tabs refreshing within moments of each other (a backgrounded tab's delayed timer firing right
    // as another tab also refreshes, or simply both tabs' independent proactive timers landing
    // close together) is an ordinary race, not a stolen/replayed token. Null outside that window.
    previousTokenVersion: { type: Number, default: null },
    previousTokenVersionExpiresAt: { type: Date, default: null },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
    // Null while active. Revoking is soft (not deleted) so a session list can still show "you
    // signed this device out" rather than the row just disappearing; a cheap periodic cleanup of
    // very old revoked rows could be added later if this collection ever grows large enough to
    // matter, but isn't needed yet.
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

module.exports = model('Session', sessionSchema)
