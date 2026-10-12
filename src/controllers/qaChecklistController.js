const QaChecklistTemplate = require('../models/QaChecklistTemplate')

// The shared base items plus whichever personal items belong to this specific user — never
// another agent's personal additions.
function visibleItems(template, userId) {
  const personal = template.personalItems.filter((i) => String(i.addedBy) === String(userId)).map((i) => i.text)
  return [...template.items, ...personal]
}

exports.get = async (req, res, next) => {
  try {
    const template = await QaChecklistTemplate.getTemplate()
    // baseItems is exposed separately so the frontend can tell a shared default (not removable —
    // it's the same checklist for everyone) apart from something this agent added themselves.
    res.json({ items: visibleItems(template, req.user._id), baseItems: template.items })
  } catch (err) {
    next(err)
  }
}

// QA/admin only — adding an item is personal to the agent adding it; it only shows up on that
// agent's own future reviews, not on every other QA member's checklist.
exports.addItem = async (req, res, next) => {
  try {
    const name = (req.body.item || '').trim()
    if (!name) return res.status(400).json({ error: 'Item name is required' })

    const template = await QaChecklistTemplate.getTemplate()
    const exists = visibleItems(template, req.user._id).some((i) => i.toLowerCase() === name.toLowerCase())
    if (!exists) {
      template.personalItems.push({ text: name, addedBy: req.user._id })
      await template.save()
    }
    res.status(201).json({ items: visibleItems(template, req.user._id), baseItems: template.items })
  } catch (err) {
    next(err)
  }
}

// QA/admin only, and only ever the requester's own personal item — a shared base item was never
// addable through here either, so there's nothing to remove there (that's the same checklist for
// everyone, not something one agent should be able to take away from the rest). Case-insensitive
// match on text, same as the duplicate check in addItem, since that's the only handle the
// frontend has on a personal item (visibleItems flattens away each one's own _id).
exports.removeItem = async (req, res, next) => {
  try {
    const name = (req.body.item || '').trim()
    if (!name) return res.status(400).json({ error: 'Item name is required' })

    const template = await QaChecklistTemplate.getTemplate()
    template.personalItems = template.personalItems.filter(
      (i) => !(String(i.addedBy) === String(req.user._id) && i.text.toLowerCase() === name.toLowerCase()),
    )
    await template.save()
    res.json({ items: visibleItems(template, req.user._id), baseItems: template.items })
  } catch (err) {
    next(err)
  }
}

// Admin only — unlike a personal item, this shows up on every QA agent's checklist. Previously
// only editable by changing the BASE_ITEMS constant and redeploying; this is the same list, just
// reachable from Settings instead of a code change.
exports.addBaseItem = async (req, res, next) => {
  try {
    const name = (req.body.item || '').trim()
    if (!name) return res.status(400).json({ error: 'Item name is required' })

    const template = await QaChecklistTemplate.getTemplate()
    const exists = template.items.some((i) => i.toLowerCase() === name.toLowerCase())
    if (!exists) {
      template.items.push(name)
      await template.save()
    }
    res.status(201).json({ items: visibleItems(template, req.user._id), baseItems: template.items })
  } catch (err) {
    next(err)
  }
}

exports.removeBaseItem = async (req, res, next) => {
  try {
    const name = (req.body.item || '').trim()
    if (!name) return res.status(400).json({ error: 'Item name is required' })

    const template = await QaChecklistTemplate.getTemplate()
    template.items = template.items.filter((i) => i.toLowerCase() !== name.toLowerCase())
    await template.save()
    res.json({ items: visibleItems(template, req.user._id), baseItems: template.items })
  } catch (err) {
    next(err)
  }
}
