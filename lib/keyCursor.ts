// A plain keyset cursor over a timestamp key + an integer id: the moments
// lists (/api/me/sessions, someone's Moments) and the Impressions list, whose
// keys are shown on the rows anyway (a sealed one is for keys that aren't:
// lib/peopleCursor.ts, lib/cravingsCursor.ts).
//
// Cursor = "<key>.<id>", base64url'd so it's opaque on the wire. Both halves
// are needed: `key` is the µs-precision sort key (an ISO-8601 string straight
// from `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, bound back as
// ::timestamptz: a JS Date is millisecond-only and would drop or repeat a row
// across the boundary), `id` is the stable tiebreak within a shared key. The
// id is base64'd LAST so a `.` can't appear after it — the key has a fixed
// shape with exactly one `.` (the fractional-seconds separator), so we split
// on the LAST dot.
import { Prisma } from '@prisma/client'

export function encodeKeyCursor(key: string, id: number): string {
  return Buffer.from(`${key}.${id}`).toString('base64url')
}

export function parseKeyCursor(raw: string | null): { key: string; id: number } | null {
  if (!raw) return null
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const dot = decoded.lastIndexOf('.')
    if (dot < 0) return null
    const key = decoded.slice(0, dot)
    const id = Number(decoded.slice(dot + 1))
    // The key must look like the to_char output — an ISO instant. Validate by
    // shape + parseability so a forged cursor can't inject arbitrary text into
    // the ::timestamptz bind (it's parameterized, but a garbage value would
    // still error; reject early to a clean "no cursor" instead).
    if (!Number.isInteger(id) || id <= 0) return null
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(key)) return null
    return { key, id }
  } catch {
    return null
  }
}

// The µs text of a timestamptz expression, UTC-normalized: the cursor's key.
export const usKeySql = (expr: Prisma.Sql) =>
  Prisma.sql`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export function clampLimit(raw: string | null, def: number, max: number): number {
  if (!raw) return def
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return def
  return Math.min(Math.floor(n), max)
}
