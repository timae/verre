// Boundary validation for check-in inputs. POST and PATCH /api/checkins
// accept user JSON; the DB has CHECK constraints (score 0–5, flavors JSONB),
// but we want to reject invalid input at the route level with a clean 400
// rather than a Prisma/Postgres error stack.

type ValidScore = { value: number | null; error?: undefined } | { value?: undefined; error: string }
type ValidFlavors = { value: Record<string, number>; error?: undefined } | { value?: undefined; error: string }

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

// Flavors: object with string keys → integers 0-5. Type-specific dimension
// sets (FL_RED, FL_WHITE, etc.) are not enforced here — legacy ratings use
// different keys per CLAUDE.md, and the chart code (detectFL) handles any
// stored shape. We only guard against malformed structures.
//
// Zero-count keys are stripped: the rewire's engagement-deletion rule
// (rewire.md §3) matches `flavors = '{}'::jsonb` to detect an empty
// rating. A payload of {red: 0, oak: 0} would round-trip with those
// keys present and the match would silently fail — so canonical form
// drops them before storage.
//
// Side-effect on detectFL (lib/flavours.ts): detectFL infers wine type
// from the *presence* of dimension keys (e.g. `dark_fruit` → FL_RED).
// Pre-rewire a chipped-then-zeroed payload still rendered with the
// inferred FL_RED dimensions; post-strip it falls through to the
// default FL. detectFL is only the fallback when wineType is unknown,
// so the reach is limited to legacy/orphan rows on profile/feed/
// compare — acceptable per the rewire trade-off.
export function validateFlavors(input: unknown): ValidFlavors {
  if (input === undefined || input === null) return { value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'flavors must be an object' }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 32) return { error: `invalid flavor key: ${k}` }
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return { error: `flavor "${k}" must be an integer` }
    if (v < 0 || v > 5) return { error: `flavor "${k}" must be between 0 and 5` }
    if (v === 0) continue
    out[k] = v
  }
  return { value: out }
}
