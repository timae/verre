// Postgres `Int` (int4) max — anything above this would overflow when
// passed to Prisma. JavaScript's `Number()` happily coerces a 21-digit
// string to a float that passes `Number.isInteger`, which then explodes
// inside Prisma. Clamp here.
const PG_INT4_MAX = 2_147_483_647

// Strict numeric-id parser for path params. Accepts only `^[1-9][0-9]*$`
// — no leading zeros, no signs, no whitespace, no decimals, no
// scientific notation, no trailing newline (which JS's `Number()` would
// silently strip). Loose parsing turned up real cases like `1%0a` and
// `1%20` resolving to user 1, which is a routing-canonicalization
// problem and bypasses any URL-keyed cache or rate limit.
//
// Returns the parsed positive integer or `null` if the input is not a
// strictly-canonical positive int4.
export function parsePathId(raw: string | undefined | null): number | null {
  if (raw == null) return null
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > PG_INT4_MAX) return null
  return n
}
