const { z } = require('zod')

const ROLES = ['poc', 'specialist', 'qa', 'admin']

const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.string().trim().min(1, 'Email is required').email('Invalid email address'),
  role: z.enum(ROLES).optional(),
  isTestAccount: z.boolean().optional(),
  chatUserId: z.string().trim().optional(),
})

module.exports = { createUserSchema }
