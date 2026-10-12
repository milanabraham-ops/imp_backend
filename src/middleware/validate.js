// Validates req.body against a Zod schema before the route handler runs — the handler can then
// trust req.body's shape/types completely instead of re-checking them itself. Never relies on
// anything the frontend already validated; this is the actual enforcement point.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const message = result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
      return res.status(400).json({ error: message })
    }
    req.body = result.data
    next()
  }
}

module.exports = { validateBody }
