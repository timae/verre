// Geo-data DELIVERY (app side): downloads the binary IP→country tables from S3
// to local disk at boot so lib/geo.ts can query them. The data is too large +
// too churny to commit to git and must NOT be fetched at request time (the IP
// must never leave the server), so the flow is:
//
//   deploy job  → scripts/refresh-geo-data.mjs: fetch fresh RIR data
//                 (best-effort, timeout) + upload to the fixed S3 keys. On any
//                 failure it leaves the existing S3 copy untouched. (Runs as a
//                 standalone .mjs with its own S3 client — it can't import this
//                 TS module — which is why there's no upload helper here.)
//   app at boot → downloadGeoData(): pull those files from S3 to GEO_DATA_DIR.
//                 lib/geo.ts then opens them on disk (seek-based search).
//
// Both sides are best-effort: if S3 has nothing yet (cold start) or is
// unreachable, the app simply has no geo files → every lookup returns null →
// "Unknown location". Nothing here can fail a deploy or a boot.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getObjectBytes } from '@/lib/s3'

const GEO_DIR = process.env.GEO_DATA_DIR || '/tmp/verre-geo'
// Fixed S3 keys, overwritten on each refresh — no accumulation.
const KEYS = ['geo-v4.bin', 'geo-v6.bin', 'geo-cc.json'] as const
const S3_PREFIX = 'geo/'

// Download the three files from S3 to local disk. Called once at boot (see
// instrumentation.ts). Best-effort: a missing/unreachable file is skipped, and
// lib/geo.ts degrades to "Unknown location" if the set is incomplete.
export async function downloadGeoData(): Promise<void> {
  try {
    mkdirSync(GEO_DIR, { recursive: true })
    for (const key of KEYS) {
      const bytes = await getObjectBytes(S3_PREFIX + key)
      if (bytes) writeFileSync(join(GEO_DIR, key), bytes)
    }
  } catch (err) {
    console.warn('[geo] downloadGeoData failed (geo labels will be unavailable):', err)
  }
}
