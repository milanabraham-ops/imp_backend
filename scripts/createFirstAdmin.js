#!/usr/bin/env node
// One-time bootstrap for a brand-new deployment: every admin route requires an existing admin to
// be logged in already (there's no public self-registration), so on a fresh production database
// nobody could ever create the first account through the app itself. Run this once, directly
// against the production MONGO_URI, right after the backend is deployed and before anyone tries
// to log in:
//
//   cd backend
//   MONGO_URI="<your production connection string>" node scripts/createFirstAdmin.js "Jane Doe" jane@example.com
//
// (Or set MONGO_URI in backend/.env.production.local / your shell and just run the two args.)
//
// Refuses to run if an admin already exists, so it can't be used to plant a second/rogue admin on
// a database that's already bootstrapped — use the app's own Manage Access screen for that once
// the first admin can log in.
//
// Creates the account with the same shared default password ('12345678') and mustChangePassword
// flag every admin-created account gets (see adminController.createUser) — log in once, you'll be
// forced to set a real password immediately, same as any account an admin creates afterward.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const User = require('../src/models/User')

const DEFAULT_PASSWORD = '12345678'

async function main() {
  const [name, email] = process.argv.slice(2)
  if (!name || !email) {
    console.error('Usage: node scripts/createFirstAdmin.js "Full Name" email@example.com')
    process.exitCode = 1
    return
  }

  const uri = process.env.MONGO_URI
  if (!uri) {
    console.error('MONGO_URI is not set — point it at the production database before running this.')
    process.exitCode = 1
    return
  }

  await mongoose.connect(uri)

  try {
    const existingAdmin = await User.findOne({ role: 'admin' })
    if (existingAdmin) {
      console.error(`Refusing to run: an admin already exists (${existingAdmin.email}). Use the app's Manage Access screen to add more.`)
      process.exitCode = 1
      return
    }

    const normalizedEmail = email.toLowerCase().trim()
    const existing = await User.findOne({ email: normalizedEmail })
    if (existing) {
      console.error(`An account with that email already exists (role: ${existing.role}).`)
      process.exitCode = 1
      return
    }

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10)
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      authProvider: 'local',
      role: 'admin',
      mustChangePassword: true,
    })

    console.log('')
    console.log(`Admin account created: ${user.email}`)
    console.log(`Temporary password: ${DEFAULT_PASSWORD}`)
    console.log('You will be required to set a new password on first login.')
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((err) => {
  console.error('Failed to create admin:', err.message)
  process.exitCode = 1
})
