const { z } = require('zod')

// Submissions have ~50 free-form fields across the multi-step wizard, already constrained by
// the Mongoose schema's own types/enums/required flags (ValidationError is caught in the
// controller). Re-declaring every one of those here would be a lot of brittle duplication for
// little real gain. What Zod adds instead: closing the one confirmed injection gap (group being
// passed unchecked into a Mongo filter) and catching structurally-wrong payloads early with a
// clear message, while leaving the rest of the fields to pass through as-is.
const createSubmissionSchema = z
  .object({
    // A plain string can never be interpreted as a Mongo query operator ({$ne: null} etc), so
    // this alone closes the injection path — it doesn't need to also match the ObjectId format
    // (an invalid-format string still fails safely later via Mongoose's CastError handling).
    group: z.string().optional(),
    clientName: z.string().trim().min(1, 'Client name is required'),
    locationName: z.string().trim().min(1, 'Location name is required'),
    market: z.enum(['Dental', 'Ophthalmology', 'Physiotherapy', 'Veterinary'], {
      message: 'Market must be one of: Dental, Ophthalmology, Physiotherapy, Veterinary',
    }),
  })
  .passthrough()

// update() is reached by every role (poc/specialist/qa/admin), each already restricted to their
// own allowed field subset by fieldsForRole() — this just makes sure that whichever of these
// tracking fields IS present is a plain string, not an injected object, without asserting exact
// casing/values (several call sites intentionally tolerate mixed case, e.g. "QA" vs "qa").
const updateSubmissionSchema = z
  .object({
    configurationStatus: z.string().optional(),
    accountOnboarded: z.string().optional(),
    implementationSpecialist: z.string().optional(),
    qaAgent: z.string().optional(),
    statusBeforeHold: z.string().optional(),
    integrationStatus: z.string().optional(),
    integrationAgent: z.string().optional(),
    forwardingNumbers: z.string().optional(),
  })
  .passthrough()

const addCommentSchema = z.object({
  text: z.string().trim().min(1, 'Comment text is required').max(2000, 'Comment is too long'),
  // Which review section this comment is scoped to (see SubmissionDetailSections) — optional,
  // the general thread posts with no section at all.
  section: z.string().trim().min(1).max(200).optional(),
})

module.exports = { createSubmissionSchema, updateSubmissionSchema, addCommentSchema }
