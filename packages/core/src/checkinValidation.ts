// Boundary validation for check-in scores. POST and PATCH /api/checkins and
// the session rate routes accept user JSON; the DB has CHECK constraints
// (score 0–5), but we reject invalid input at the route level with a clean
// 400 rather than a Prisma/Postgres error stack.
//
// validateFlavors stays server-side in lib/checkinValidation.ts — it carries
// the engagement-deletion zero-strip behavior that's tied to the storage
// layer's '{}'::jsonb empty-rating match, not a client concern.

type ValidScore = { value: number | null; error?: undefined } | { value?: undefined; error: string }

export function validateScore(input: unknown): ValidScore {
  if (input === undefined || input === null) return { value: null }
  if (typeof input !== 'number' || !Number.isFinite(input)) return { error: 'score must be a number' }
  if (input < 0 || input > 5) return { error: 'score must be between 0 and 5' }
  // Quarter-stars: only multiples of 0.25 are allowed. Multiplying by
  // 4 and integer-checking is more reliable than `(input * 100) % 25`
  // because of float quirks (0.1 + 0.2 ≠ 0.3). 4× is exact for any
  // .00/.25/.50/.75 fraction.
  const quarters = input * 4
  if (!Number.isInteger(quarters)) return { error: 'score must be a multiple of 0.25' }
  return { value: input }
}
