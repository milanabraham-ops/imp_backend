// Configuration Status and Account Onboarded are free-text dropdown cells the implementation team
// edits directly in the Sheet — the exact casing they type (QA, qa, Qa, Closed, CLOSED, ...) can
// vary and isn't meaningful, only the letters are. Every comparison against these two fields
// anywhere in the app should go through here rather than a raw === so casing never matters.
function normalizeStatus(value) {
  return (value || '').trim().toUpperCase()
}

function statusEquals(value, target) {
  return normalizeStatus(value) === normalizeStatus(target)
}

function statusIsOneOf(value, targets) {
  const normalized = normalizeStatus(value)
  return targets.some((t) => normalizeStatus(t) === normalized)
}

module.exports = { normalizeStatus, statusEquals, statusIsOneOf }
