const User = require('../models/User')

const STAFF_ROLES = ['qa', 'specialist', 'admin']

// A lightweight, non-admin-only list of who's assignable to QA/configuration work — unlike
// GET /admin/users (admin-only, full account detail), this is just enough to populate a
// "reassign to" dropdown, and stays in sync automatically as the admin adds/removes agents.
exports.list = async (req, res, next) => {
  try {
    const users = await User.find({ role: { $in: STAFF_ROLES } })
      .select('name role')
      .sort({ name: 1 })
    res.json(users.map((u) => ({ id: u._id, name: u.name, role: u.role })))
  } catch (err) {
    next(err)
  }
}
