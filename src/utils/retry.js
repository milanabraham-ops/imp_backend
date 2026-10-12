const logger = require('./logger')

// Exponential-backoff retry for a flaky external call. Used for the Sheets/Chat sync calls that
// used to be single-attempt fire-and-forget (a transient network blip or a momentary 5xx from
// Google was enough to silently lose the write) — 3 attempts with 500ms/1s/2s backoff turns most
// of those into a non-issue without the caller needing to know or care.
async function withRetry(fn, { attempts = 3, baseDelayMs = 500, label = 'operation' } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        logger.warn({ err, label, attempt, attempts, delay }, `${label} failed, retrying`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastErr
}

module.exports = { withRetry }
