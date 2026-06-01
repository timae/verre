// Coarse, country-ONLY geolocation for the "Connected devices" panel. Country
// level (e.g. "Switzerland"), never city — city needs a licensed dataset,
// whereas country-level IP→country is derivable from PUBLIC RIR delegation
// statistics (public domain, no EULA, no attribution, no account). See
// docs/dev/proposals/auth-sessions.md §14.
//
// PRIVACY — the lookup is fully IN-PROCESS. The IP is NEVER sent to any third
// party (no API, no WHOIS); the data lives locally. The raw IP is never
// persisted either — only the derived country label (or null) reaches the DB.
//
// MEMORY — the ~326k ranges are NOT loaded into memory. They live as sorted
// fixed-width BINARY files on local disk (geo-v4.bin / geo-v6.bin); each lookup
// binary-searches by SEEKING to a byte offset and reading one record (a few
// bytes). The OS page cache keeps hot pages warm. Only the tiny country-index
// (239 codes, ~1KB) is held in memory. See scripts/generate-geo-table.mjs for
// the record layout and how the files get to disk (deploy job → S3 → app
// downloads to GEO_DATA_DIR at boot; see lib/geoData.ts).
//
// HARD CONTRACT (proposal §5) — login must NEVER fail because geo errors:
// resolveGeoLabel resolves to null on any throw (and the caller in auth.ts also
// wraps it in `.catch(() => null)`). If the files are absent (not yet
// downloaded / cold start), every lookup returns null → "Unknown location".

import { openSync, readSync, readFileSync, existsSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { countryName } from '@/lib/countries'

// Where the app keeps the downloaded binary files (written by lib/geoData.ts on
// boot). Overridable for tests/local; defaults to a tmp dir so a read-only
// image filesystem isn't a problem.
const GEO_DIR = process.env.GEO_DATA_DIR || '/tmp/verre-geo'
const V4_PATH = join(GEO_DIR, 'geo-v4.bin')
const V6_PATH = join(GEO_DIR, 'geo-v6.bin')
const CC_PATH = join(GEO_DIR, 'geo-cc.json')

const V4_REC = 9    // startU32 | endU32 | ccIdxU8
const V6_REC = 33   // start[16] | end[16] | ccIdxU8

// Lazily-opened state. Resolved on first lookup; null until then or if the
// files aren't present (→ all lookups return null, gracefully).
type GeoState = { v4fd: number; v4n: number; v6fd: number; v6n: number; cc: string[] }
let state: GeoState | null = null
let initTried = false

function init(): GeoState | null {
  if (initTried) return state
  try {
    // Don't latch when the files simply aren't here YET — the boot download
    // (instrumentation.ts → downloadGeoData) may still be in flight. Latching
    // here on a files-absent first lookup would disable geo for the whole
    // process life. Return null without latching so a later lookup retries
    // once the files land. Only a successful open or a genuine parse/open
    // error latches.
    if (!existsSync(V4_PATH) || !existsSync(V6_PATH) || !existsSync(CC_PATH)) return null
    initTried = true
    const cc = JSON.parse(readFileSync(CC_PATH, 'utf8')) as string[]
    const v4fd = openSync(V4_PATH, 'r')
    const v6fd = openSync(V6_PATH, 'r')
    const v4size = fstatSync(v4fd).size
    const v6size = fstatSync(v6fd).size
    state = { v4fd, v4n: Math.floor(v4size / V4_REC), v6fd, v6n: Math.floor(v6size / V6_REC), cc }
    return state
  } catch {
    initTried = true   // genuine error (corrupt JSON, open failure) → don't retry
    return null
  }
}

// IPv4 string → 32-bit int, or null.
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = [m[1], m[2], m[3], m[4]].map(Number)
  if (o.some(x => x > 255)) return null
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}

// IPv6 string → 16-byte big-endian Buffer, or null. Handles `::` + zone id.
function ipv6ToBuf(ip: string): Buffer | null {
  const raw = ip.split('%')[0]
  if (!raw.includes(':')) return null
  const halves = raw.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head
  if (groups.length !== 8) return null
  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i]
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    buf.writeUInt16BE(parseInt(g, 16), i * 2)
  }
  return buf
}

// Seek-based binary search over the IPv4 file. Reads one 9-byte record per
// probe. Returns the country index or -1.
function searchV4(s: GeoState, value: number): number {
  const rec = Buffer.alloc(V4_REC)
  let lo = 0, hi = s.v4n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    // A short read (truncated/corrupt file) must NOT fall through to reading
    // stale bytes left in the reused buffer — that could return a WRONG
    // country. Treat any incomplete record as a miss.
    if (readSync(s.v4fd, rec, 0, V4_REC, mid * V4_REC) !== V4_REC) return -1
    const start = rec.readUInt32BE(0)
    const end = rec.readUInt32BE(4)
    if (value < start) hi = mid - 1
    else if (value > end) lo = mid + 1
    else return rec.readUInt8(8)
  }
  return -1
}

// Seek-based binary search over the IPv6 file. 33-byte records; compare 16-byte
// big-endian buffers lexicographically (== numeric order).
function searchV6(s: GeoState, value: Buffer): number {
  const rec = Buffer.alloc(V6_REC)
  let lo = 0, hi = s.v6n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (readSync(s.v6fd, rec, 0, V6_REC, mid * V6_REC) !== V6_REC) return -1
    const start = rec.subarray(0, 16)
    const end = rec.subarray(16, 32)
    if (Buffer.compare(value, start) < 0) hi = mid - 1
    else if (Buffer.compare(value, end) > 0) lo = mid + 1
    else return rec.readUInt8(32)
  }
  return -1
}

// Returns an ISO-3166 alpha-2 country code for an IP, or null. Never throws.
function lookupCountry(ip: string): string | null {
  const s = init()
  if (!s) return null
  try {
    let idx: number
    if (ip.includes(':')) {
      const buf = ipv6ToBuf(ip)
      idx = buf === null ? -1 : searchV6(s, buf)
    } else {
      const v = ipv4ToInt(ip)
      idx = v === null ? -1 : searchV4(s, v)
    }
    return idx >= 0 && idx < s.cc.length ? s.cc[idx] : null
  } catch {
    return null
  }
}

// Resolve a coarse country LABEL (display name) from a client IP, mapping the
// alpha-2 code to a friendly name via lib/countries.ts. Never throws; returns
// null on miss/parse-failure. Async only to satisfy the existing call-site
// contract — the work is synchronous.
export async function resolveGeoLabel(ip: string | null | undefined): Promise<string | null> {
  if (!ip || ip === 'unknown') return null
  try {
    const cc = lookupCountry(ip)
    if (!cc) return null
    return countryName(cc) ?? null
  } catch {
    return null
  }
}
