const { Schema, model } = require('mongoose')

// Per-PMS integration guide links, admin-managed (same singleton pattern as QaChecklistTemplate)
// so adding a new PMS's doc or swapping a stale link never needs a code change/deploy. The POC
// picks a PMS on the form; if a doc is on file for it, a link to that doc is shown so they know
// what info to gather — replacing the old approach of typing real credentials straight into the
// form. Every entry here also doubles as a dropdown suggestion on the form (see usePmsDocs), so an
// admin can register a new PMS integration by name alone — `url` isn't required, since the doc
// itself is often written after the integration is already in use; it gets attached later by
// upserting the same name again.
const pmsDocSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, default: '', trim: true },
  },
  { _id: false },
)

const pmsDocTemplateSchema = new Schema(
  {
    docs: { type: [pmsDocSchema], default: () => [] },
  },
  { timestamps: true },
)

async function getTemplate() {
  let doc = await this.findOne()
  if (!doc) doc = await this.create({})
  return doc
}

pmsDocTemplateSchema.statics.getTemplate = getTemplate

module.exports = model('PmsDocTemplate', pmsDocTemplateSchema)
