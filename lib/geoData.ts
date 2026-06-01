// Geo-data DELIVERY (app side): gets the binary IP→country tables onto local
// disk so lib/geo.ts can query them. The data is too large + too churny to
// commit to git and must NOT be fetched at request time (the IP must never
// leave the server), so:
//
//   scheduled cron → scripts/refresh-geo-data.mjs (weekly): fetch fresh RIR
//                    data + upload to the fixed S3 keys. (.deploio.yaml)
//   app at boot    → ensureGeoData(): download those files from S3 to
//                    GEO_DATA_DIR. If S3 is EMPTY (cold start, before the first
//                    cron has run), kick off a one-time seed (generate+upload)
//                    in the BACKGROUND so a fresh deploy isn't blank until the
//                    weekly cron fires — without blocking boot on a ~50MB fetch.
//
// Best-effort throughout: if S3 has nothing and the seed hasn't finished, geo
// lookups return null → "Unknown location". Nothing here can fail a boot.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getObjectBytes } from '@/lib/s3'

const GEO_DIR = process.env.GEO_DATA_DIR || '/tmp/verre-geo'
// Fixed S3 keys, overwritten on each refresh — no accumulation.
const KEYS = ['geo-v4.bin', 'geo-v6.bin', 'geo-cc.json'] as const
const S3_PREFIX = 'geo/'
// The refresh script lives in the /migrate dir of the runtime image (see
// Dockerfile) — same place the deploy job and scheduled jobs run it from.
// Overridable (GEO_REFRESH_SCRIPT) for local dev / tests where the path differs.
const REFRESH_SCRIPT = process.env.GEO_REFRESH_SCRIPT || '/migrate/scripts/refresh-geo-data.mjs'

// Download the three files from S3 to local disk. Returns the count downloaded
// (0 = S3 has none yet). Best-effort: a missing/unreachable file is skipped.
async function downloadGeoData(): Promise<number> {
  let got = 0
  try {
    mkdirSync(GEO_DIR, { recursive: true })
    for (const key of KEYS) {
      const bytes = await getObjectBytes(S3_PREFIX + key)
      if (bytes) { writeFileSync(join(GEO_DIR, key), bytes); got++ }
    }
  } catch (err) {
    console.warn('[geo] download failed (geo labels unavailable):', err)
  }
  return got
}

// Boot entrypoint (instrumentation.ts). Download the full set from S3; if it's
// incomplete (cold start before any scheduled refresh has run, OR a partial
// upload), seed S3 once in the background so a fresh deploy isn't blank — without
// blocking startup on a ~50MB fetch.
//
// IMPORTANT: the background seed writes to S3, NOT to this instance's GEO_DIR.
// So after kicking it off we poll: re-download from S3 a few times (spaced out,
// non-blocking) so THIS instance picks up the freshly-seeded files without
// waiting for a restart. Each poll is best-effort; once the full set lands we
// stop. If seeding never succeeds, geo stays "Unknown location" — never a crash.
export async function ensureGeoData(): Promise<void> {
  const got = await downloadGeoData()
  // Require the FULL set: lib/geo.ts needs all three files, and a partial S3
  // set (got 1-2) must still trigger a reseed rather than be treated as "done".
  if (got === KEYS.length) return
  console.warn(`[geo] S3 geo data incomplete (${got}/${KEYS.length}) — seeding in background (cold start)`)
  try {
    const child = spawn(process.execPath, [REFRESH_SCRIPT], { detached: true, stdio: 'ignore' })
    child.unref()  // don't let the child keep the event loop / boot waiting
    child.on('error', (err) => console.warn('[geo] background seed failed to start:', err))
  } catch (err) {
    console.warn('[geo] background seed spawn error:', err)
    return
  }
  // Self-heal THIS instance: poll S3 until the seed lands (or we give up). The
  // generator fetches+parses ~50MB then uploads, so first attempt ~60-120s out;
  // poll a handful of times. unref'd timers never hold the process open.
  let attempts = 0
  const poll = () => {
    attempts++
    downloadGeoData().then((n) => {
      if (n === KEYS.length) { console.warn('[geo] background seed landed; geo now available'); return }
      if (attempts < 6) setTimeout(poll, 60_000).unref()
    }).catch(() => { if (attempts < 6) setTimeout(poll, 60_000).unref() })
  }
  setTimeout(poll, 60_000).unref()
}
