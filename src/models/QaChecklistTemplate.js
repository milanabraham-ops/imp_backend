const { Schema, model } = require('mongoose')

// The product keeps changing, so the QA checklist can't be a fixed list baked into code — this
// is a singleton document (same pattern as Settings) holding the current shared set of items,
// growable by QA/admin as new things need verifying. Every account's own qaChecklist is merged
// against this list when opened for review, so a newly added item shows up on every account
// still awaiting completion, not just ones created after it was added.
const BASE_ITEMS = [
  'Features',
  'Phone Number',
  'Purchase Numbers',
  'Fax Number',
  'Location',
  'Location Mapping',
  'Extensions',
  'Agents',
  'Agent Multiple Caller ID',
  'IP Address(es)',
  'Devices',
  'Agent Detection',
  'Line keys',
  'Cordless & AX83H model',
  'RPS',
  'Ring Groups',
  'Call Queue',
  'SVM',
  'Phone Tree(s)',
  'Offline Phone Tree(s)',
  'IVR + VM Audios',
  'External Number',
  'Schedule',
  'Provisioning Profile',
  'Fax Permissions',
  'Automated Workflow',
  'Holiday Calendar',
  'Admin Users',
  'Potential Opportunities',
  'AI Usage',
]

const qaChecklistTemplateSchema = new Schema(
  {
    // The shared/base list, visible to every QA agent — unchanged shape (kept as plain strings
    // so existing documents don't need a migration).
    items: { type: [String], default: () => [...BASE_ITEMS] },
    // An item a specific agent adds mid-review, private to them — it shouldn't clutter every
    // other agent's checklist with a one-off item only that reviewer wanted to track.
    personalItems: {
      type: [{ text: String, addedBy: { type: Schema.Types.ObjectId, ref: 'User' } }],
      default: [],
    },
  },
  { timestamps: true },
)

async function getTemplate() {
  let doc = await this.findOne()
  if (!doc) doc = await this.create({})
  return doc
}

qaChecklistTemplateSchema.statics.getTemplate = getTemplate

module.exports = model('QaChecklistTemplate', qaChecklistTemplateSchema)
