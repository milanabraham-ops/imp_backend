const { Schema, model } = require('mongoose')
const { encrypt, decrypt } = require('../utils/encryption')

const fileRefSchema = new Schema(
  {
    // Drive is the primary store now — fileId (GridFS) is only ever set when Drive wasn't
    // configured at upload time (local/dev fallback). driveFileId is the real Drive file id,
    // needed to delete the file later; driveUrl is just the human-clickable view/download link.
    fileId: { type: Schema.Types.ObjectId, default: null },
    driveFileId: { type: String, default: '' },
    filename: { type: String, default: '' },
    driveUrl: { type: String, default: '' },
  },
  { _id: false },
)

const qaChecklistItemSchema = new Schema(
  {
    item: { type: String, required: true },
    // '' = not yet reviewed, 'ok' = no issue, 'error' = something's wrong (see note),
    // 'clarification' = QA has a question about it (see note), 'na' = doesn't apply here.
    status: { type: String, enum: ['', 'ok', 'error', 'clarification', 'na'], default: '' },
    note: { type: String, default: '' },
  },
  { _id: false },
)

// Test feature (see checkpoint tag `checkpoint-before-phone-sheet-v2`) — structured phone/device
// info uploaded from the paired CSV/XLSX template (see submissionController's uploadPhoneSheet)
// and shown read-only in the app. Deliberately flat/free-text per field rather than enums — this
// is real-world installer-entered data, not a dropdown-driven app field.
const phoneSheetDeviceSchema = new Schema(
  {
    deviceMake: { type: String, default: '' },
    deviceModel: { type: String, default: '' },
    mac: { type: String, default: '' },
    serial: { type: String, default: '' },
    ipuiCode: { type: String, default: '' },
    // Free text — typically "Assigned" or "Common", but not enforced; who it's assigned to (if
    // anyone) goes here too rather than a separate field, since a sheet fills this in as one cell.
    assignment: { type: String, default: '' },
    extension: { type: String, default: '' },
    hotDesking: { type: Boolean, default: false },
  },
  { _id: true },
)

const phoneSheetAgentSchema = new Schema(
  {
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    isAdminUser: { type: Boolean, default: false },
    extension: { type: String, default: '' },
    hotDeskingUser: { type: Boolean, default: false },
    faxAccess: { type: Boolean, default: false },
  },
  { _id: true },
)

const commentSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String, required: true },
    text: { type: String, required: true },
    // Which review section (matched by its title, e.g. "Links, Attachments & PMS") this comment is
    // about — null for a comment posted from the general thread at the bottom, not tied to any one
    // section. Fixed at post time, same as authorRole; an edit only ever changes the text.
    section: { type: String, default: null, trim: true },
    // Who this specific comment should notify — the POC when a staff member (specialist/qa/
    // admin) posts, or whichever staff member posted most recently when the POC replies. Kept
    // per-comment (not derived at read time) so the notification target is fixed at the moment
    // it's written, and doesn't shift later if a different agent takes over the submission.
    notifyUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Staff members @-mentioned in this comment's text (matched by name against the staff roster
    // at post/edit time — see submissionController's resolveMentions). Not currently wired into
    // NotificationContext's poll (see that file's comment-category note) since the dedicated
    // /notifications/feed projection doesn't include it yet — kept here so a full submission
    // fetch can still show/use it.
    mentions: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: () => [] },
    createdAt: { type: Date, default: Date.now },
    // Set (alongside a text update) when the comment's own author edits it later — null means
    // never edited, so the UI only shows "(edited)" once this is actually stamped.
    editedAt: { type: Date, default: null },
  },
  { _id: true },
)

const queueDetailSchema = new Schema(
  {
    onholdType: { type: String, default: '' },
    onholdScript: { type: String, default: '' },
    onholdFile: { type: fileRefSchema, default: () => ({}) },
    maxDuration: { type: String, default: '' },
    maxCallers: { type: String, default: '' },
    announcement: { type: [String], default: [] },
    exitType: { type: String, default: '' },
    exitKey: { type: String, default: '' },
    exitScript: { type: String, default: '' },
    exitFile: { type: fileRefSchema, default: () => ({}) },
  },
  { _id: false },
)

// A location can have several independent ring groups, each with its own SVM, voicemail
// settings, and call queue setup — not one shared config for the whole location.
const ringGroupSchema = new Schema(
  {
    // "Same configuration as previous" copies every field below except ringGroupUsers from the
    // prior ring group — the one thing that's always allowed to differ is who's actually in the
    // group. Like sameSvmAsPrevious, the flag only drives the form's UI; every field always
    // holds its own actual resolved value, so nothing downstream needs to resolve the flag.
    sameConfigAsPrevious: { type: Boolean, default: false },

    ringType: { type: String, default: '' },
    ringDuration: { type: String, default: '' },
    ringGroupUsers: { type: String, default: '' },

    // "Same as previous" copies the prior ring group's SVM users so it doesn't need re-typing
    // when several ring groups genuinely share one voicemail group — the flag just drives the
    // form's UI (disables the field); svmUsers itself always holds the actual resolved value,
    // so nothing downstream (Sheet export, review screen) needs to resolve the flag.
    sameSvmAsPrevious: { type: Boolean, default: false },
    svmUsers: { type: String, default: '' },

    vmEmail: { type: String, default: '' },
    vmEmailAddresses: { type: String, default: '' },
    queueType: { type: String, default: '' },
    queue: {
      exit: { type: queueDetailSchema, default: () => ({}) },
      dq: { type: queueDetailSchema, default: () => ({}) },
      qo: { type: queueDetailSchema, default: () => ({}) },
    },
    autoDial: { type: String, default: '' },
  },
  { _id: false },
)

const submissionSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
    // Stamped true at creation when the owner is a test account — lets test submissions live
    // alongside real ones in every view (same queues, same stats) while still being identifiable
    // and bulk-purgeable on their own.
    isTestData: { type: Boolean, default: false, index: true },

    // Step 1 — Account & Location
    clientName: { type: String, required: true, trim: true },
    locationName: { type: String, required: true, trim: true },
    locationBillable: { type: String, default: '' },
    market: { type: String, required: true, enum: ['Dental', 'Ophthalmology', 'Physiotherapy', 'Veterinary'] },
    environment: { type: String, default: '' },
    billingPlan: { type: String, default: '' },
    poc: { type: String, default: '' },
    timezone: { type: String, default: '' },
    goLiveDate: { type: String, default: '' },

    // Step 2 — Phone & Hours
    phoneNumbers: { type: String, default: '' },
    businessDays: { type: [String], default: [] },
    businessHours: { type: String, default: '' },
    afterHoursDays: { type: [String], default: [] },
    afterHoursTiming: { type: String, default: '' },
    customHolidays: { type: String, default: '' },

    // Step 3 — Call Flow
    phoneTree: { type: String, default: '' },
    callFlow: { type: String, default: '' },
    afterHoursPhoneTree: { type: String, default: '' },
    afterHoursCondition: { type: String, default: '' },

    // Step 4 — Audio
    audioLanguage: { type: String, default: '' },
    welcomeType: { type: String, default: '' },
    welcomeScript: { type: String, default: '' },
    welcomeFile: { type: fileRefSchema, default: () => ({}) },
    ahvmType: { type: String, default: '' },
    ahvmScript: { type: String, default: '' },
    ahvmFile: { type: fileRefSchema, default: () => ({}) },
    bhvmType: { type: String, default: '' },
    bhvmScript: { type: String, default: '' },
    bhvmFile: { type: fileRefSchema, default: () => ({}) },

    // Step 5 — Ring / Queue (a location can have several independent ring groups)
    ringGroups: { type: [ringGroupSchema], default: () => [] },

    // Step 6 — Devices
    lineKeys: { type: String, default: '' },
    hotDesking: { type: String, default: '' },
    adminUsers: { type: String, default: '' },
    aiLimit: { type: String, default: '' },
    cardAssignment: { type: String, default: '' },
    cardVisibility: { type: String, default: '' },

    // Step 7 — Workflows
    workflow: { type: String, default: '' },
    workflowCondition: { type: String, default: '' },
    workflowAction: { type: [String], default: [] },
    smsContent: { type: String, default: '' },
    dni: { type: String, default: '' },
    dniCampaigns: { type: String, default: '' },
    smsNumbers: { type: String, default: '' },
    smsUsers: { type: String, default: '' },
    textUnification: { type: String, default: '' },
    faxNumbers: { type: String, default: '' },
    faxUsers: { type: String, default: '' },

    // Step 8 — Links & PMS
    phoneSheetLink: { type: String, default: '' },
    // Test feature — structured version of the above link's contents, uploaded as a CSV/XLSX of
    // the paired template (see submissionController's uploadPhoneSheet) and shown read-only in
    // Step 6 (Devices, Agents & Access). Uploadable both before this submission exists (parsed
    // server-side via the stateless parsePhoneSheet endpoint, then staged client-side like any
    // other wizard field until Submit) and after (parsed and saved immediately) — same template
    // either way.
    phoneSheetDevices: { type: [phoneSheetDeviceSchema], default: () => [] },
    phoneSheetAgents: { type: [phoneSheetAgentSchema], default: () => [] },
    questionnaireLink: { type: String, default: '' },
    additionalNotes: { type: String, default: '' },
    pms: { type: String, default: '' },
    // Real login credentials for the client's PMS system — encrypted at rest (AES-256-GCM) via
    // this set/get pair, transparent to the rest of the app: assign/read plaintext as normal,
    // Mongoose handles the ciphertext underneath. Requires `toJSON`/`toObject` getters enabled
    // below, since Express's res.json() serializes through toJSON().
    serverAccess: {
      type: String,
      default: '',
      set: (value) => encrypt(value),
      get: (value) => decrypt(value),
    },

    // Tracking — mirrored from the manually-maintained dropdown columns in the Google Sheet.
    // The sheet is the source of truth; these are a durable backup so the info survives
    // even if the Sheet is temporarily unreachable or the row is ever removed.
    accountOnboarded: { type: String, default: '' },
    configurationStatus: { type: String, default: '' },
    implementationSpecialist: { type: String, default: '' },

    // App-only (not mirrored to the Sheet, which has no matching column) — who on the QA team
    // actually reviewed this one, so QA members can see their own review history separately from
    // the shared QA queue.
    qaAgent: { type: String, default: '' },

    // App-only — the QA reviewer's per-item checklist for this account (Configuration, Phone
    // Number, Ring Groups, etc). Filled in as part of marking the account Completed; its
    // errors/clarifications get attached to the completion notification in Chat.
    qaChecklist: { type: [qaChecklistItemSchema], default: () => [] },

    // App-only — whatever configurationStatus was right before "On Hold" was set, so "Resume"
    // can restore it exactly (Not Started/In Progress for a specialist-side hold, QA for a
    // QA-side hold). Cleared back to '' once resumed.
    statusBeforeHold: { type: String, default: '' },

    // Auto-stamped the moment configurationStatus is first observed as COMPLETED — also doubles
    // as the "already stamped" guard so it's only written once.
    completionDate: { type: Date, default: null },
    daysTakenToComplete: { type: Number, default: null },

    // App-only — set the moment the (separate, deliberate) Handover action posts to the POC's
    // Chat space. Completed just means QA signed off internally; this is the actual "the client
    // has been told" moment, since QA may want to hold off announcing it right away.
    pocHandoverAt: { type: Date, default: null },

    // App-only — stamped the moment a specialist genuinely hands this off to QA (not QA resuming
    // their own on-hold review, and not a silent recheck reopening). Drives the "new QA request"
    // notification, separately from createdAt (which only tells you when the location itself was
    // first submitted, not when it actually became QA's problem).
    qaHandoffAt: { type: Date, default: null },

    // App-only — a Sheets-comment-style discussion thread on this account. Anyone who can
    // configure it (specialist/qa/admin) or the POC who owns it can post; everyone with access to
    // the submission can read the whole log, but only notifyUserId gets alerted per comment.
    comments: { type: [commentSchema], default: () => [] },

    // App-only — free-text list of numbers forwarded to this account's phone system (one per
    // line). Deliberately NOT gated like the other tracking fields: a POC edits it the same way
    // as any other setup field, and specialist/qa can too (see TRACKING_FIELDS_BY_ROLE) — anyone
    // with access to this submission can add one, so whoever notices it first records it rather
    // than it falling through the cracks between roles. De-duplicated on save by comparing
    // digits only (see utils/phoneNumber.js), so "(555) 123-4567" and "555-123-4567" typed on
    // separate lines collapse to one rather than both being kept.
    forwardingNumbers: { type: String, default: '' },
    // Whether this account actually needs its numbers forwarded — defaults off so a brand new
    // practice doesn't automatically clutter the Forwarding Numbers page (see
    // ForwardingNumbersPage.jsx, which only lists submissions where this is true) before anyone's
    // actually confirmed it needs that setup; flipped on later once it's actually needed.
    forwardingNumberRequired: { type: Boolean, default: false },

    // App-only — a standing snapshot of the most recent audit-log entry for this submission
    // (see utils/auditLog.js), kept in sync with every logged action. The full audit log is
    // pruned after its retention window (Settings.auditLogRetentionDays); this survives that
    // pruning so "who last touched this, and when" is never lost even once the detailed log
    // entry that produced it is gone. Who submitted it (owner), who's reviewing (qaAgent), and
    // its status (configurationStatus) are already permanent fields above — this is the one
    // fact the log alone used to carry.
    lastActivityAt: { type: Date, default: null },
    lastActivityBy: { type: String, default: '' },
    lastActivityByRole: { type: String, default: '' },
    lastActivitySummary: { type: String, default: '' },

    // App-only — set when a background sync to an external system (currently just 'sheets';
    // Sheets is the system of record the implementation team actually relies on, unlike Chat's
    // one-off notification pings) exhausts its retries (see utils/retry.js / services/sheetSync.js).
    // At most one entry per service — cleared the moment that service's sync next succeeds,
    // whether that's the next normal edit or a manual "Retry Sync" (see exports.retrySync).
    // Surfaced as a small warning badge on the card rather than staying a server-log line nobody
    // ever sees.
    syncIssues: {
      type: [
        {
          service: { type: String, required: true },
          message: { type: String, required: true },
          at: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: () => [],
    },

    // App-only — set only when the POC edits the actual setup data (never a tracking field,
    // which a POC can't touch at all). Distinct from lastActivityAt/By above, which cover every
    // actor's actions: this specifically drives the "POC edited this" notification to
    // specialist/QA/admin, so staff editing their own tracking fields never notifies themselves.
    lastPocEditAt: { type: Date, default: null },
    lastPocEditSummary: { type: String, default: '' },

    // App-only — a separate, parallel tracking dimension from configurationStatus/QA above,
    // for hooking this location's PMS up to the phone system. Only relevant for a non-"CS
    // Voicestack" environment with a PMS actually specified — a CS Voicestack account is always
    // already wired to CareStack directly, so it never gets one of these. Auto-created (blank ->
    // 'Needle Request (OneApi Cred)') the moment a submission first qualifies, in either create() or
    // update() (see submissionController.js's needsIntegration) — never something a POC or staff
    // member has to remember to start themselves. '', 'Needle Request (OneApi Cred)', 'OneAPI Setup &
    // Integration Process', 'L2 Handover', or 'Completed'. Anyone but a POC can take one over (no
    // specialist/QA split here, unlike configurationStatus) — ownership-gated the same way as the
    // other tracking fields.
    integrationStatus: { type: String, default: '' },
    integrationAgent: { type: String, default: '' },
    integrationTicketCreatedAt: { type: Date, default: null },
    integrationCompletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    // Needed for serverAccess's getter (decryption) to actually run on the way out — without
    // this, res.json()/toObject() would return the raw ciphertext instead of the plaintext.
    toJSON: { getters: true },
    toObject: { getters: true },
  },
)

module.exports = model('Submission', submissionSchema)
