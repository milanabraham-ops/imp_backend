// Strips everything but digits so "(555) 123-4567", "555-123-4567", "555.123.4567" and
// "5551234567" all compare equal — forwarding numbers get typed in from whatever format the
// source (a phone's own display, a carrier export, someone typing it by hand) happened to use.
function normalizePhoneNumber(raw) {
  return (raw || '').replace(/\D/g, '')
}

module.exports = { normalizePhoneNumber }
