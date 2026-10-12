const { z } = require('zod')

// Only checks shape/type here — the detailed complexity rules (uppercase/lowercase/number/
// special character) live in utils/passwordPolicy.js, which gives per-requirement error messages
// instead of one generic Zod regex failure.
const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
})

module.exports = { loginSchema, changePasswordSchema }
