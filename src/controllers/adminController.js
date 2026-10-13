const bcrypt = require('bcryptjs')
const User = require('../models/User')
const Session = require('../models/Session')
const { logAction } = require('../utils/auditLog')

const ROLES = ['poc', 'specialist', 'qa', 'admin']
// Every admin-created account starts with this same password (not one the admin picks) — the
// account is forced to change it on first login (see mustChangePassword), so there's no real
// value in the admin choosing a one-off temporary password each time.
const DEFAULT_PASSWORD = '12345678'

function toPublicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl || '',
    role: user.role || 'poc',
    authProvider: user.authProvider,
    mustChangePassword: Boolean(user.mustChangePassword),
    isTestAccount: Boolean(user.isTestAccount),
    chatUserId: user.chatUserId || '',
    createdAt: user.createdAt,
  }
}

exports.listUsers = async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 })
    res.json(users.map(toPublicUser))
  } catch (err) {
    next(err)
  }
}

exports.createUser = async (req, res, next) => {
  try {
    const { name, email, role, isTestAccount, chatUserId } = req.body
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' })
    }
    if (role && !ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` })
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() })
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' })

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10)
    const user = await User.create({
      name: name.trim(),
      email,
      passwordHash,
      authProvider: 'local',
      role: role || 'poc',
      mustChangePassword: true,
      isTestAccount: Boolean(isTestAccount),
      chatUserId: (chatUserId || '').trim(),
    })

    res.status(201).json(toPublicUser(user))

    logAction({
      actor: req.user,
      action: 'user.create',
      targetType: 'User',
      targetId: user._id,
      targetLabel: `${user.name} (${user.email})`,
      summary: `Created ${user.role} account for ${user.name}`,
    })
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    next(err)
  }
}

// Revokes access by deleting the account outright — they can no longer log in. Their historical
// submissions/tracking-field entries (owner, implementationSpecialist, qaAgent, poc are all
// free text or a dangling ref, never cascade-deleted) stay in place as a record of past work.
exports.removeUser = async (req, res, next) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot remove your own account' })
    }

    const user = await User.findByIdAndDelete(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.status(204).end()

    // Tidiness, not correctness — refresh() already rejects any orphaned session once
    // User.findById(session.userId) comes back empty, this just clears them out rather than
    // leaving dead rows behind.
    Session.deleteMany({ userId: user._id }).catch((err) => req.log.error({ err, userId: user._id }, 'Failed to clean up sessions for deleted user'))

    logAction({
      actor: req.user,
      action: 'user.delete',
      targetType: 'User',
      targetId: user._id,
      targetLabel: `${user.name} (${user.email})`,
      summary: `Removed ${user.role} account for ${user.name}`,
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid user id' })
    next(err)
  }
}

exports.updateRole = async (req, res, next) => {
  try {
    const { role } = req.body
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` })

    if (String(req.params.id) === String(req.user._id) && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot remove your own admin role' })
    }

    const prevUser = await User.findById(req.params.id)
    if (!prevUser) return res.status(404).json({ error: 'User not found' })
    const prevRole = prevUser.role

    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true })
    res.json(toPublicUser(user))

    if (prevRole !== user.role) {
      logAction({
        actor: req.user,
        action: 'user.role_change',
        targetType: 'User',
        targetId: user._id,
        targetLabel: `${user.name} (${user.email})`,
        summary: `Changed ${user.name}'s role from ${prevRole} to ${user.role}`,
      })
    }
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid user id' })
    next(err)
  }
}

// The only recourse today if someone forgets their password after already completing
// mustChangePassword was deleting and recreating the account — orphaning every free-text/owner
// reference to their old name. This resets them straight back to the same forced-change flow a
// brand-new account goes through, without touching anything else. Not available for a Google
// Sign-In account — there's no passwordHash to reset, they don't authenticate with a password at
// all. Revoking every session for the account ends all of them immediately, same as a real
// password change would (see authController.changePassword).
exports.resetPassword = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.authProvider !== 'local' || !user.passwordHash) {
      return res.status(400).json({ error: 'This account signs in with Google and has no password to reset' })
    }

    user.previousPasswordHashes = [user.passwordHash, ...user.previousPasswordHashes].slice(0, 5)
    user.passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10)
    user.mustChangePassword = true
    await user.save()
    await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() })
    res.json(toPublicUser(user))

    logAction({
      actor: req.user,
      action: 'user.password_reset',
      targetType: 'User',
      targetId: user._id,
      targetLabel: `${user.name} (${user.email})`,
      summary: `Reset ${user.name}'s password to the default, forced to change it on next login`,
    })
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid user id' })
    next(err)
  }
}

// The Chat mention ID has no source of truth inside this app to look it up from (unlike role,
// name, email) — it's only findable externally (Directory API, People API, or capturing it from
// a browser network request), so this just records whatever the admin already tracked down.
exports.updateChatUserId = async (req, res, next) => {
  try {
    const chatUserId = (req.body.chatUserId || '').trim()
    const user = await User.findByIdAndUpdate(req.params.id, { chatUserId }, { new: true })
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(toPublicUser(user))
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid user id' })
    next(err)
  }
}
