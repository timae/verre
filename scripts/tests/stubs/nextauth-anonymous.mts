// Test stub for `@/auth` (NextAuth), used by scripts/tests/redis-rehydration-
// additive.mts. Route handlers run outside Next's request scope there, where
// NextAuth's auth() cannot read headers(). Every logged-in actor in that suite
// authenticates through the REAL Better Auth branch of lib/resolveUser.ts; the
// web branch is reached only by callers with no session cookie at all, for whom
// NextAuth's auth() returns null — which is exactly what this stub returns.
export async function auth() {
  return null
}
