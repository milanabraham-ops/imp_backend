const PmsDocTemplate = require('../models/PmsDocTemplate')

// Open to anyone authenticated (POC included) — they need this to see the guide for whichever
// PMS they pick on the form, not just admins.
exports.get = async (req, res, next) => {
  try {
    const template = await PmsDocTemplate.getTemplate()
    res.json({ docs: template.docs })
  } catch (err) {
    next(err)
  }
}

// Admin only. Upsert by name (case-insensitive) — re-adding the same PMS just updates its URL
// rather than creating a duplicate entry. `url` is deliberately optional: the integration itself
// (the PMS name, which also surfaces it as a dropdown suggestion on the form) is often known
// before its guide doc is actually written — an admin can add the name alone now and come back to
// attach the URL once it's ready, rather than being blocked on having it up front.
exports.upsert = async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim()
    const url = (req.body.url || '').trim()
    if (!name) return res.status(400).json({ error: 'PMS name is required' })

    const template = await PmsDocTemplate.getTemplate()
    const existing = template.docs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      existing.url = url
    } else {
      template.docs.push({ name, url })
    }
    await template.save()
    res.status(201).json({ docs: template.docs })
  } catch (err) {
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'PMS name is required' })

    const template = await PmsDocTemplate.getTemplate()
    template.docs = template.docs.filter((d) => d.name.toLowerCase() !== name.toLowerCase())
    await template.save()
    res.json({ docs: template.docs })
  } catch (err) {
    next(err)
  }
}
