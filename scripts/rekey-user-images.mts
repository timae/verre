// Re-key the user-bearing public image objects (public-user-ids § 8, D2: an
// image address carries nothing that points to a person, new AND existing).
//
//   npx tsx scripts/rekey-user-images.mts [--apply | --reclaim] [--manifest FILE]
//
// Old key shapes (all public-read): `avatars/u_<int>_…`, `avatars/cover_u_<int>_…`,
// `avatars/tile_<tile>_u_<int>_…`, `wines/ci_<int>_…`. New ones: lib/imageKeys.ts.
//
// Dry run (default): discovery only, nothing written. Counts per kind, rows
// under a FOREIGN endpoint prefix (keys are parsed from the `/<bucket>/`
// segment, so the stored endpoint never matters), referenced objects missing
// from the bucket, unreferenced old objects (orphans), and overlap-era own
// tiles (a legacy own upload whose tile_*_own_url is stale).
//
// --apply: ONE object at a time, in ONE shuffled order across all users
// (CopyObject stamps Last-Modified with the copy time, so going owner by owner
// would group one person's photos by time). Per object: the new key goes to
// the manifest FIRST (the check-in PATCH / DELETE read the prior image outside
// any users-row lock, so a copy can lose its race even after the
// compare-and-set), then CopyObject, then a short transaction that locks the
// owner's users row FOR UPDATE (it serializes with replace, profile PATCH and
// account deletion) and compare-and-sets every column holding the old URL
// (`WHERE col = old`). A tile column whose old URL passes the legacy own test
// for that row's user and tile also gets own_url = new (an own upload made
// through an old instance during the overlap has a stale own_url; moving only
// the url would make it not-own and the next profile read would clear it).
// Orphans are recorded without a copy.
//
// --reclaim (a separate later run, repeatable): for every manifest entry,
// deletes the old object, and the new one, only when no column references it
// (a crash between a copy and its compare-and-set leaves the old URL live).
// Until then already-loaded pages keep their images and the old objects are
// the way back.
//
// 🔒 The manifest pairs integer-bearing old keys with new ones: it is
// OPERATOR-LOCAL, never committed, and deleted after the reclaim. It defaults
// to `.local/rekey/` (git-ignored), a path inside the checkout that git would
// track is refused, and it is written owner-only (0600).
// One --apply / --reclaim at a time per manifest (a lock file beside it): a
// reclaim reading a line an apply has just written (copied, rows not yet
// pointed at it) would delete the new object.
// Runbook: docs/dev/deployment.md § Re-key user images.
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { randomInt } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createPrismaClient } from './lib/prismaClient.mjs'
import { imageKey, type ImageKind } from '../lib/imageKeys.ts'
import type { PrismaClient } from '@prisma/client'

type Mode = 'dry' | 'apply' | 'reclaim'
export type RunOpts = { mode: Mode; manifest: string; prisma?: PrismaClient; s3?: S3Client; bucket?: string; log?: (o: Record<string, unknown>) => void }

const TILES = ['impressions', 'moments', 'cravings'] as const
// Every URL column that can hold a user-bearing key.
const USER_COLS = ['image_url', 'cover_photo_url', 'tile_impressions_url', 'tile_moments_url', 'tile_cravings_url',
  'tile_impressions_own_url', 'tile_moments_own_url', 'tile_cravings_own_url'] as const
const OTHER_COLS = [['wines', 'image_url'], ['rating_images', 'image_url']] as const

type Parsed = { kind: ImageKind; owner: number; ext: string }
export function parseOldKey(key: string): Parsed | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1] ?? ''
  let m: RegExpExecArray | null
  if ((m = /^avatars\/u_(\d+)_[^/]+$/.exec(key))) return { kind: 'avatar', owner: Number(m[1]), ext }
  if ((m = /^avatars\/cover_u_(\d+)_[^/]+$/.exec(key))) return { kind: 'cover', owner: Number(m[1]), ext }
  if ((m = /^avatars\/tile_(impressions|moments|cravings)_u_(\d+)_[^/]+$/.exec(key))) return { kind: `tile_${m[1]}` as ImageKind, owner: Number(m[2]), ext }
  if ((m = /^wines\/ci_(\d+)_[^/]+$/.exec(key))) return { kind: 'checkin', owner: Number(m[1]), ext }
  return null
}

export const DEFAULT_MANIFEST = '.local/rekey/rekey-user-images.manifest.jsonl'

function lockManifest(manifest: string): () => void {
  const lock = `${manifest}.lock`
  let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch { throw new Error(`${lock} exists: another --apply / --reclaim is running on this manifest (delete the lock only if none is)`) }
  writeSync(fd, String(process.pid))
  closeSync(fd)
  return () => { try { unlinkSync(lock) } catch {} }
}

// The ONE path the manifest is checked, locked, read and written at: its
// directory (created 0700) by its real path, then its own name, which must not
// be a symlink. Case, symlinked and `..` spellings all land here.
export function canonicalManifest(manifest: string): string {
  const dir = dirname(resolve(manifest))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(realpathSync.native(dir), basename(manifest))
  let link = false
  try { link = lstatSync(path).isSymbolicLink() } catch {} // absent: fine
  if (link) throw new Error(`refusing manifest ${manifest}: it is a symlink`)
  return path
}

export async function run(opts: RunOpts) {
  if (opts.mode === 'dry') return runModes(opts)
  const manifest = canonicalManifest(opts.manifest)
  const release = lockManifest(manifest)
  try { return await runModes({ ...opts, manifest }) } finally { release() }
}

async function runModes(opts: RunOpts) {
  const prisma = opts.prisma ?? createPrismaClient()
  const bucket = opts.bucket ?? process.env.S3_BUCKET
  const endpoint = process.env.S3_ENDPOINT
  if (!bucket) throw new Error('S3_BUCKET is not set')
  const s3 = opts.s3 ?? new S3Client({
    endpoint, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
  })
  const log = opts.log ?? ((o) => console.log(JSON.stringify(o)))
  const keyOf = (url: string) => { const at = url.indexOf(`/${bucket}/`); return at < 0 ? null : url.slice(at + bucket.length + 2) }
  const prefixOf = (url: string) => url.slice(0, url.indexOf(`/${bucket}/`) + bucket.length + 2)
  // Exact: the stored URL ends with `/<bucket>/<key>` (any endpoint prefix).
  const referenced = async (key: string): Promise<boolean> => {
    const tail = `/${bucket}/${key}`
    for (const col of USER_COLS) {
      if ((await prisma.$queryRawUnsafe<{ x: number }[]>(`SELECT 1 AS x FROM users WHERE right(${col}, length($1)) = $1 LIMIT 1`, tail)).length) return true
    }
    for (const [t, col] of OTHER_COLS) {
      if ((await prisma.$queryRawUnsafe<{ x: number }[]>(`SELECT 1 AS x FROM ${t} WHERE right(${col}, length($1)) = $1 LIMIT 1`, tail)).length) return true
    }
    return false
  }

  if (opts.mode === 'reclaim') {
    if (!existsSync(opts.manifest)) throw new Error(`no manifest at ${opts.manifest}`)
    const entries = readFileSync(opts.manifest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { old: string; new: string | null })
    let deleted = 0, kept = 0
    for (const e of entries) {
      for (const key of [e.old, e.new]) {
        if (!key) continue
        if (await referenced(key)) { kept++; continue }
        try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); deleted++ } catch { kept++ }
      }
    }
    const summary = { mode: 'reclaim', entries: entries.length, deleted, kept }
    log(summary)
    return summary
  }

  // ── discovery: the bucket listing ∪ every URL column ────────────────────────
  const objects = new Set<string>()
  for (const prefix of ['avatars/', 'wines/ci_']) {
    let token: string | undefined
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of page.Contents ?? []) if (o.Key && parseOldKey(o.Key)) objects.add(o.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  const refs = new Map<string, Set<string>>() // key → the stored URLs naming it
  let foreign = 0
  const note = (url: string | null) => {
    if (!url) return
    const key = keyOf(url)
    if (!key || !parseOldKey(key)) return
    if (endpoint && !url.startsWith(`${endpoint}/${bucket}/`)) foreign++
    const set = refs.get(key) ?? new Set<string>()
    set.add(url); refs.set(key, set)
  }
  for (const col of USER_COLS) for (const r of await prisma.$queryRawUnsafe<{ u: string | null }[]>(`SELECT ${col} AS u FROM users WHERE ${col} IS NOT NULL`)) note(r.u)
  for (const [t, col] of OTHER_COLS) for (const r of await prisma.$queryRawUnsafe<{ u: string | null }[]>(`SELECT ${col} AS u FROM ${t} WHERE ${col} IS NOT NULL`)) note(r.u)
  const missing = [...refs.keys()].filter((k) => !objects.has(k))
  const orphans = [...objects].filter((k) => !refs.has(k))
  const overlap = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT COUNT(*)::int AS n FROM users u, LATERAL (VALUES
      ('impressions', u.tile_impressions_url, u.tile_impressions_own_url),
      ('moments', u.tile_moments_url, u.tile_moments_own_url),
      ('cravings', u.tile_cravings_url, u.tile_cravings_own_url)) t(tile, url, own)
    WHERE t.url IS NOT NULL AND t.url IS DISTINCT FROM t.own
      AND strpos(t.url, '/avatars/tile_' || t.tile || '_u_' || u.id || '_') > 0`)
  const byKind: Record<string, number> = {}
  for (const k of objects) { const p = parseOldKey(k)!; byKind[p.kind] = (byKind[p.kind] ?? 0) + 1 }
  const discovery = { objects: objects.size, byKind, referenced: refs.size, missingSources: missing.length, orphans: orphans.length, foreignPrefixRows: foreign, overlapEraOwnTiles: overlap[0]?.n ?? 0 }
  if (opts.mode === 'dry') { log({ mode: 'dry', ...discovery }); return { mode: 'dry', ...discovery } }

  // ── apply ───────────────────────────────────────────────────────────────────
  const order = [...objects]
  for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]] }
  let copied = 0, updatedRows = 0, lost = 0, failed = 0
  for (const oldKey of order) {
    const p = parseOldKey(oldKey)!
    const urls = refs.get(oldKey)
    if (!urls) { appendFileSync(opts.manifest, JSON.stringify({ old: oldKey, new: null }) + '\n', { mode: 0o600 }); continue }
    const newKey = `${imageKey(p.kind)}${p.ext ? `.${p.ext}` : ''}`
    appendFileSync(opts.manifest, JSON.stringify({ old: oldKey, new: newKey }) + '\n', { mode: 0o600 })
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: oldKey }))
      await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: newKey, CopySource: `${bucket}/${oldKey}`, ContentType: head.ContentType, MetadataDirective: 'REPLACE' }))
      copied++
    } catch { failed++; continue }
    let n = 0
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${p.owner} FOR UPDATE`
      for (const oldUrl of urls) {
        const newUrl = prefixOf(oldUrl) + newKey
        n += await tx.$executeRaw`UPDATE users SET image_url = ${newUrl} WHERE image_url = ${oldUrl}`
        n += await tx.$executeRaw`UPDATE users SET cover_photo_url = ${newUrl} WHERE cover_photo_url = ${oldUrl}`
        for (const t of TILES) {
          const url = `tile_${t}_url`, own = `tile_${t}_own_url`
          // url moves; own_url follows when it equalled the old URL, or when the
          // old URL is this row's legacy own upload for this tile (overlap era).
          n += await tx.$executeRawUnsafe(`
            UPDATE users SET ${url} = $1,
              ${own} = CASE WHEN ${own} = $2 OR strpos($2, '/avatars/tile_${t}_u_' || id || '_') > 0 THEN $1 ELSE ${own} END
            WHERE ${url} = $2`, newUrl, oldUrl)
          n += await tx.$executeRawUnsafe(`UPDATE users SET ${own} = $1 WHERE ${own} = $2`, newUrl, oldUrl)
        }
        n += await tx.$executeRaw`UPDATE wines SET image_url = ${newUrl} WHERE image_url = ${oldUrl}`
        n += await tx.$executeRaw`UPDATE rating_images SET image_url = ${newUrl} WHERE image_url = ${oldUrl}`
      }
    })
    if (n === 0) lost++
    updatedRows += n
  }
  const summary = { mode: 'apply', ...discovery, copied, updatedRows, lostRaces: lost, copyFailed: failed, manifest: opts.manifest }
  log(summary)
  return summary
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const mode: Mode = args.includes('--reclaim') ? 'reclaim' : args.includes('--apply') ? 'apply' : 'dry'
  const mi = args.indexOf('--manifest')
  const manifest = mi >= 0 ? args[mi + 1] : DEFAULT_MANIFEST
  if (args.includes('--apply') && args.includes('--reclaim')) { console.error('--apply and --reclaim are separate runs'); process.exit(2) }
  // 🔒 Never a manifest git would track (the repo is public). Git is asked
  // about the manifest's OWN directory (by its real path), whatever the cwd.
  let manifestPath: string
  try { manifestPath = canonicalManifest(manifest) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(2) }
  const dir = dirname(manifestPath)
  let inWorkTree = false
  try { inWorkTree = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' } catch {}
  if (inWorkTree) {
    try { execFileSync('git', ['-C', dir, 'check-ignore', '-q', '--', basename(manifestPath)], { stdio: 'ignore' }) } catch {
      console.error(`refusing --manifest ${manifest}: it is inside a git work tree and git does not ignore it (use ${DEFAULT_MANIFEST} or a path outside any repo)`); process.exit(2)
    }
  }
  run({ mode, manifest: manifestPath }).then(() => process.exit(0), (e) => { console.error('[rekey] failed:', e instanceof Error ? e.message : e); process.exit(1) })
}
