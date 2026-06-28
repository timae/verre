// Boundary validation for check-in flavors. POST and PATCH /api/checkins
// accept user JSON; the DB has CHECK constraints (flavors JSONB), but we
// want to reject invalid input at the route level with a clean 400 rather
// than a Prisma/Postgres error stack.
//
// validateScore moved to @verre/core (pure, shared with native). validateFlavors
// stays server-side: its zero-strip is tied to the storage layer's
// '{}'::jsonb empty-rating match (see below), not a client concern.

type ValidFlavors = { value: Record<string, number>; error?: undefined } | { value?: undefined; error: string }

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
  // Two-pass strip (structure-wheel §5, "drop-all-or-keep-all"). Pass 1:
  // validate every entry and collect it. Pass 2: if EVERY value is 0 the user
  // rated nothing → return {} (preserves the '{}' empty-rating signal the
  // engagement cascade + hasEngagement key on). If ANY value is non-zero, keep
  // ALL entries including the explicit zeros — a rated-None axis is real data
  // ("perceived none"), not absence. This replaces the old single-pass strip
  // that dropped every zero unconditionally.
  const all: Record<string, number> = {}
  let anyNonZero = false
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 32) return { error: `invalid flavor key: ${k}` }
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return { error: `flavor "${k}" must be an integer` }
    if (v < 0 || v > 5) return { error: `flavor "${k}" must be between 0 and 5` }
    all[k] = v
    if (v !== 0) anyNonZero = true
  }
  return { value: anyNonZero ? all : {} }
}
