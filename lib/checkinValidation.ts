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
// the axis SET (which keys are valid for a wine's style) is NOT enforced here —
// that's the registry-keyed write gate's job (assertRegistryKeyed in
// lib/flavours.ts, called per-route). This function only guards STRUCTURE
// (object of string→int 0–5) and applies the zero rule below.
//
// Zero rule — DROP-ALL-OR-KEEP-ALL (structure-wheel §5). The engagement-
// deletion cascade matches `flavors = '{}'::jsonb` to detect an empty rating,
// so the empty signal must be preserved. But under the structure model a
// present 0 means "rated None" (real data), not "missing". Reconciliation:
//   - EVERY value is 0 → the user rated nothing → return {} (empty signal).
//   - ANY value is non-zero → keep ALL entries, INCLUDING the explicit zeros.
// So {acid:4, body:0} stores its zeros (one non-zero ⇒ all survive); {acid:0,
// body:0} collapses to {}. This replaced the old "strip every zero" pass.
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
