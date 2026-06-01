// Deploy-job geo refresh. Runs the generator to produce fresh binary tables,
// then uploads them to the fixed S3 keys the app downloads at boot.
//
// Usage:   node scripts/refresh-geo-data.mjs
//
// BEST-EFFORT — this must NEVER fail a deploy. Any error (RIR source down,
// timeout, S3 unreachable) is logged and the script exits 0, leaving the
// existing S3 copy in place. The app degrades to "Unknown location" only if S3
// has nothing at all (cold start) — never a broken deploy or login.
//
// Wired into .deploio.yaml's deployJob AFTER `prisma migrate deploy`. Migrations
// remain the only thing that can fail a deploy; geo is additive and optional.
//
// Reads S3 config from the same env as the app: S3_ENDPOINT, S3_BUCKET,
// S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const GENERATOR = new URL('./generate-geo-table.mjs', import.meta.url).pathname
const KEYS = ['geo-v4.bin', 'geo-v6.bin', 'geo-cc.json']
const S3_PREFIX = 'geo/'
const FETCH_TIMEOUT_MS = 60_000  // the generator fetches ~50MB; give it a minute.

function log(msg) { process.stderr.write(`[geo-refresh] ${msg}\n`) }

// Run the generator into a temp dir, with a hard timeout. Resolves to the dir
// on success, throws on failure/timeout.
function runGenerator(outDir) {
  return new Promise((resolve, reject) => {
    // process.execPath, not bare 'node' — the deploy job runs under sh -c where
    // PATH resolution is implicit; use the exact node binary running this
    // script (same posture as .deploio.yaml calling Prisma's JS entry directly).
    const child = spawn(process.execPath, [GENERATOR, outDir], { stdio: ['ignore', 'ignore', 'inherit'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('generator timed out')) }, FETCH_TIMEOUT_MS)
    child.on('exit', code => {
      clearTimeout(timer)
      code === 0 ? resolve(outDir) : reject(new Error(`generator exited ${code}`))
    })
    child.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

async function upload(outDir) {
  const endpoint = process.env.S3_ENDPOINT
  const bucket = process.env.S3_BUCKET
  if (!endpoint || !bucket) throw new Error('S3 not configured (S3_ENDPOINT/S3_BUCKET unset)')
  const s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
    forcePathStyle: true,
  })
  for (const key of KEYS) {
    const body = readFileSync(join(outDir, key))
    const contentType = key.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: S3_PREFIX + key, Body: body, ContentType: contentType }))
    log(`uploaded ${S3_PREFIX}${key} (${(body.length / 1e6).toFixed(1)}MB)`)
  }
}

async function main() {
  const outDir = mkdtempSync(join(tmpdir(), 'geo-'))
  log(`generating into ${outDir}…`)
  await runGenerator(outDir)
  log('uploading to S3…')
  await upload(outDir)
  log('done — fresh geo tables in S3.')
}

// Overall deadline. runGenerator has its own fetch timeout, but the S3 uploads
// don't — a half-open connection could hang `await upload()` and stall the
// whole deploy (this runs in the deployJob chain). Cap the entire refresh so it
// can never block the release; on timeout we keep the existing S3 copy.
const OVERALL_TIMEOUT_MS = 120_000
const deadline = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('overall refresh timed out')), OVERALL_TIMEOUT_MS).unref(),
)

Promise.race([main(), deadline]).then(
  () => process.exit(0),
  err => {
    // Swallow: leave the existing S3 copy in place, never fail the deploy.
    log(`refresh skipped (existing S3 copy kept): ${err.message}`)
    process.exit(0)
  },
)
