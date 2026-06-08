// Coerce Prisma `Decimal` runtime objects to plain JS numbers before
// they hit the wire. NextResponse.json serializes Decimal via its
// `.toJSON()` method, which emits a quoted string like `"4.25"`. That
// silently breaks every client that compares the field as a number
// (`n <= score` star loops, `score > 0` truthy checks, edit forms that
// submit the value back through validateScore which then rejects it).
//
// Safe for the codebase's score range: 0.00..5.00 in 0.25 steps. All
// of these are dyadic fractions, exactly representable as JS doubles
// — Number(d) is round-trip exact.
//
// Use at every API edge that returns a score field.
//
// The input is typed structurally (`{ toString(): string } | number | null`)
// rather than `Prisma.Decimal` so this module pulls no @prisma/client into
// core — Prisma.Decimal satisfies the structural shape at every call site.

type Decimalish = { toString(): string } | number | null | undefined

export function decimalToNumber(value: Decimalish): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  // Prisma.Decimal — `Number()` coerces via toString → parseFloat.
  // Exact for the score quarter-step range; would lose precision on
  // values outside ±2^53, but score is bounded 0..5.
  return Number(value)
}
