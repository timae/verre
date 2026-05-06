// Boundary validation for check-in inputs. POST and PATCH /api/checkins
// accept user JSON; the DB has CHECK constraints (score 0–5, flavors JSONB),
// but we want to reject invalid input at the route level with a clean 400
// rather than a Prisma/Postgres error stack.

type ValidScore = { value: number | null; error?: undefined } | { value?: undefined; error: string }
type ValidFlavors = { value: Record<string, number>; error?: undefined } | { value?: undefined; error: string }

export function validateScore(input: unknown): ValidScore {
  if (input === undefined || input === null) return { value: null }
  if (typeof input !== 'number' || !Number.isFinite(input)) return { error: 'score must be a number' }
  if (!Number.isInteger(input)) return { error: 'score must be an integer' }
  if (input < 0 || input > 5) return { error: 'score must be between 0 and 5' }
  return { value: input }
}

// Flavors: object with string keys → integers 0-5. Type-specific dimension
// sets (FL_RED, FL_WHITE, etc.) are not enforced here — legacy ratings use
// different keys per CLAUDE.md, and the chart code (detectFL) handles any
// stored shape. We only guard against malformed structures.
export function validateFlavors(input: unknown): ValidFlavors {
  if (input === undefined || input === null) return { value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'flavors must be an object' }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 32) return { error: `invalid flavor key: ${k}` }
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return { error: `flavor "${k}" must be an integer` }
    if (v < 0 || v > 5) return { error: `flavor "${k}" must be between 0 and 5` }
    out[k] = v
  }
  return { value: out }
}
