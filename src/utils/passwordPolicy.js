// Enforced specifically on the forced first-login change (the only place a user picks their
// own password now that admin-created accounts all start on the same shared default) — strong
// enough that swapping the default for another easy-to-guess password isn't a real option.
const MIN_LENGTH = 8
// bcrypt silently truncates anything past 72 bytes — capping well under that (rather than at
// exactly 72) keeps the limit simple to explain and leaves headroom for multi-byte characters,
// which take more than one byte each.
const MAX_LENGTH = 128

// Small, deliberately short blocklist — not a full breached-password database (that's a real
// external dependency, e.g. HaveIBeenPwned's API), just the obvious "technically passes every
// other rule" cases: keyboard walks, the app's own name, and the shared admin-set default
// itself, so a user "resetting" onto a slightly-modified default doesn't defeat the point of
// forcing a change at all. Checked case-insensitively against the whole password.
const COMMON_PASSWORDS = [
  'password', 'password1', 'password123', 'passw0rd',
  'qwerty', 'qwertyuiop', 'qwerty123',
  '12345678', '123456789', '1234567890',
  'letmein', 'welcome', 'welcome1', 'admin123', 'changeme',
  'voicestack', 'voicestack1', 'voicestack123',
  'iloveyou', 'monkey123', 'football', 'dragon123',
]

function validatePassword(password) {
  if (!password || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`
  if (password.length > MAX_LENGTH) return `Password must be no more than ${MAX_LENGTH} characters`
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter'
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter'
  if (!/[0-9]/.test(password)) return 'Password must include a number'
  if (!/[^a-zA-Z0-9]/.test(password)) return 'Password must include a special character'
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) return 'That password is too common, please choose something less guessable'
  return null
}

module.exports = { validatePassword }
