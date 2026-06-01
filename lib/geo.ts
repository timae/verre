// Coarse, country-ONLY geolocation for the "Connected devices" panel. v1 is
// deliberately country-level (e.g. "CH"), never city — city-level needs a
// licensed dataset (MaxMind/DB-IP) even when self-hosted, whereas country-level
// IP→country mapping is derivable from PUBLIC RIR delegation statistics (no
// EULA, no attribution, refreshable from public data). See proposal §14 + the
// auth-sessions feature decisions.
//
// HARD CONTRACT (proposal §5) — login must NEVER fail because geo is slow or
// down:
//   - resolveGeoLabel() resolves to `null` on ANY thrown error.
//   - It resolves to `null` after a 200ms hard timeout regardless of progress.
//   - The caller still wraps it in `.catch(() => null)` as belt-and-suspenders.
// The RAW IP is NEVER persisted — only the derived country label (or null).
//
// v1 status: the IP→country table is loaded from a generated data file built
// from public RIR data (scripts/build-geo-table — see feature docs). Until that
// file exists, lookup() returns null and every device row renders "Unknown
// location". The geoLabel column + this interface are forward-compatible, so
// wiring the table later is a drop-in with no schema or call-site change.

const TIMEOUT_MS = 200

// Pluggable country lookup. Returns an ISO-3166 alpha-2 country code (e.g.
// "CH") or null when unknown / no table loaded. Synchronous + in-memory once
// the table is loaded; no network on the login path by design.
function lookupCountry(_ip: string): string | null {
  // v1: no table wired yet. Country-only RIR table loads here in the follow-up.
  return null
}

// Resolve a coarse geo label from a client IP. Never throws; never blocks
// longer than TIMEOUT_MS. Returns null on miss, error, or timeout.
export async function resolveGeoLabel(ip: string | null | undefined): Promise<string | null> {
  if (!ip || ip === 'unknown') return null
  try {
    const lookup = new Promise<string | null>((resolve) => {
      try { resolve(lookupCountry(ip)) } catch { resolve(null) }
    })
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))
    return await Promise.race([lookup, timeout])
  } catch {
    return null
  }
}
