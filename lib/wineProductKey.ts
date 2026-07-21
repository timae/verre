// Canonical wine-product match key — the deterministic dedup anchor that maps
// many per-session/per-checkin `wines` rows onto one `wine_products` row.
//
// 🔒 PARITY INVARIANT: this MUST stay byte-identical to the SQL twin
// `f_wine_match_key` / `f_wine_norm` in
// prisma/migrations/20260721120000_wine_products/migration.sql. If they drift,
// a wine created at runtime mints a second product instead of joining the one
// its siblings were backfilled into. Parity is guaranteed by normalizing
// through the Unicode NFD STANDARD (JS String.prototype.normalize('NFD') ==
// Postgres normalize(x, NFD)), NOT the `unaccent` dictionary (which has no JS
// equivalent). scripts/check-wine-product-key-parity.mjs pins it.
//
// Algorithm, in exact order: NFD-decompose → strip combining marks
// [U+0300–U+036F] → lowercase → collapse every [^a-z0-9] run to one space →
// trim. The final output is only [a-z0-9 ], so the \u0001 join separator can
// never appear inside a component ("ab"+"c" can't collide with "a"+"bc").

export function normWineField(s?: string | null): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function wineMatchKey(producer?: string | null, name?: string | null, vintage?: string | null): string {
  return `${normWineField(producer)}\u0001${normWineField(name)}\u0001${normWineField(vintage)}`
}

// A wine is linkable only when its name normalizes to something non-empty —
// mirrors the backfill's `WHERE f_wine_norm(name) <> ''` guard, so a
// punctuation/whitespace-only name never mints a junk product.
export function hasLinkableName(name?: string | null): boolean {
  return normWineField(name) !== ''
}
