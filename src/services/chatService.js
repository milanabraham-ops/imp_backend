// Google Chat incoming webhooks — simplest integration for a one-way notification (no OAuth,
// no published/installed Chat app, just a POST to a per-space URL). Two spaces total: the
// QA/specialist team's internal space, and the implementation POC's space — URLs are
// admin-managed (Settings), not env vars, so swapping a space needs no deploy/restart.
//
// Every message except the initial "new request" bot ping is user-composed (the specialist/QA/
// POC edits it before it sends), so this file is mostly two generic "post this text" senders
// rather than one function per event.
const Settings = require('../models/Settings')
const { withRetry } = require('../utils/retry')

function submissionLabel(submission) {
  return `${submission.clientName || 'Untitled'} (${submission.locationName || 'Untitled location'})`
}

// Retried (3 attempts, exponential backoff) rather than single-shot — a momentary network blip or
// a transient 5xx from Chat used to just silently drop the notification. No persisted "last sync
// failed" state here (unlike Sheets, see sheetSync.js) — these are one-off notification pings, not
// the system of record the implementation team relies on, so there's nothing meaningful to show a
// "retry" button for after the fact; the underlying event (handoff, handover, etc.) already
// happened and is reflected elsewhere regardless of whether the Chat ping made it.
async function postToWebhook(webhookUrl, text) {
  if (!webhookUrl) return
  await withRetry(
    async () => {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`Google Chat webhook responded ${res.status}`)
    },
    { label: 'Google Chat webhook post' },
  )
}

// New request just came in — the one fixed, system-generated message (everything else in this
// file is user-composed). @all-pinged since nobody's picked it up yet and any specialist could
// be the one to take it.
async function notifyNewRequest(submission) {
  const settings = await Settings.getSettings()
  const label = submissionLabel(submission)
  await postToWebhook(settings.gchatQaWebhookUrl, `<users/all> New implementation request submitted by *${submission.poc || 'a POC'}* for *${label}*.`)
}

// Every QA/specialist-team message from here on (handoff notes, QA result, recheck-fixed) is
// composed by whoever triggers it — this just posts it as-is.
async function postToQaGroup(message) {
  const settings = await Settings.getSettings()
  await postToWebhook(settings.gchatQaWebhookUrl, message)
}

// Every POC-facing message (the new-request confirmation, the final handover) is composed by
// the POC/specialist/QA member sending it — this just posts it as-is.
async function postToPocGroup(message) {
  const settings = await Settings.getSettings()
  await postToWebhook(settings.gchatPocWebhookUrl, message)
}

module.exports = { notifyNewRequest, postToQaGroup, postToPocGroup }
