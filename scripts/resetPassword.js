#!/usr/bin/env node
// Break-glass recovery: the in-app "Reset Password" button (adminController.resetPassword) needs
// another admin to already be logged in to click it. If there's only one admin account and they
// forget their password, nobody could reach it through the app at all. Run this directly against
// the production MONGO_URI instead:
//
//   cd backend
//   MONGO_URI="<your production connection string>" node scripts/resetPassword.js someone@example.com
//
// (Or set MONGO_URI in backend/.env.production.local / your shell and just pass the email.)
//
// Does exactly what the in-app button does: resets to the shared default password, forces a
// change on next login, and revokes every existing session for that account. Works on any role,
// including admin. Refuses a Google Sign-In account, same as the in-app version, there's no
// passwordHash to reset, it doesn't authenticate with a password at all.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const User = require('../src/models/User')
const Session = require('../src/models/Session')

const DEFAULT_PASSWORD = '12345678'

async function main() {
  const [email] = process.argv.slice(2)
  if (!email) {
    console.error('Usage: node scripts/resetPassword.js email@example.com')
    process.exitCode = 1
    return
  }

  const uri = process.env.MONGO_URI
  if (!uri) {
    console.error('MONGO_URI is not set, point it at the production database before running this.')
    process.exitCode = 1
    return
  }

  await mongoose.connect(uri)

  try {
    const normalizedEmail = email.toLowerCase().trim()
    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      console.error(`No account found with email ${normalizedEmail}.`)
      process.exitCode = 1
      return
    }
    if (user.authProvider !== 'local' || !user.passwordHash) {
      console.error(`${user.email} signs in with Google and has no password to reset.`)
      process.exitCode = 1
      return
    }

    user.previousPasswordHashes = [user.passwordHash, ...user.previousPasswordHashes].slice(0, 5)
    user.passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10)
    user.mustChangePassword = true
    await user.save()
    await Session.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() })

    console.log('')
    console.log(`Password reset for: ${user.email} (${user.role})`)
    console.log(`Temporary password: ${DEFAULT_PASSWORD}`)
    console.log('Every existing session for this account has been signed out.')
    console.log('They will be required to set a new password on next login.')
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((err) => {
  console.error('Failed to reset password:', err.message)
  process.exitCode = 1
})
