const { Schema, model } = require('mongoose')

// The PMS dropdown's original hardcoded suggestion list (frontend/src/data/options.js's
// PMS_OPTIONS), duplicated here rather than imported since backend and frontend are separate
// deployments with no shared module boundary. Folded into this admin-managed list below so every
// PMS the form already knew about becomes manageable (and doc-attachable) from Settings too,
// instead of living in two disconnected places — keep this in sync if that list ever changes.
const LEGACY_PMS_NAMES = [
  'Bitwerx',
  'CareStack',
  'CurveDental',
  'Dentally',
  'Denticon',
  'DenticonProxy',
  'DentrixAscend',
  'DentrixCore',
  'EagleSoft',
  'EmpowerEMR',
  'EyeCloudPro',
  'NexHealth',
  'OpenDental',
  'PromptEMR',
  'RevolutionEHR',
  'Rhapsody',
  'Vetspire',
  'Zavy360',
]

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

// Backfills any LEGACY_PMS_NAMES not yet present (blank url, same as an admin adding a PMS by name
// alone) — never touches an existing entry, so an admin-attached doc link or a differently-cased
// admin-added duplicate is left exactly as-is. Runs on every call rather than once at creation
// time, so an already-existing template (this collection predates the legacy list being folded in)
// gets backfilled too, not just a brand-new one.
async function getTemplate() {
  let doc = await this.findOne()
  if (!doc) doc = await this.create({})

  const existingNames = new Set(doc.docs.map((d) => d.name.toLowerCase()))
  const missing = LEGACY_PMS_NAMES.filter((name) => !existingNames.has(name.toLowerCase()))
  if (missing.length > 0) {
    doc.docs.push(...missing.map((name) => ({ name, url: '' })))
    await doc.save()
  }

  return doc
}

pmsDocTemplateSchema.statics.getTemplate = getTemplate

module.exports = model('PmsDocTemplate', pmsDocTemplateSchema)
