// Re-key the moment photos stored under GUESSABLE keys (leak-fixes F3 + F4):
//   - old wine photos `wines/<wineId>.<ext>` (before 2026-11-08, PR #103): a
//     blind payload keeps the bottle's `id`, so the label photo was fetchable
//     from the public bucket by anyone in the moment, revealed or not;
//   - old moment covers `sessions/<CODE>_<Date.now()>.<ext>` (create until
//     2026-11-08, settings until 2026-11-11, PR #113): the key carries the
//     JOIN CODE.
// Sibling of scripts/rekey-user-images.mts (same manifest rules), separate
// because the consistency unit is the MOMENT (its locks), not the users row.
//
//   npx tsx scripts/rekey-session-images.mts [--apply | --reclaim] [--manifest FILE]
//
// Discovery (every mode): the bucket listing (`wines/` minus `wines/ci_`,
// `sessions/`) ∪ wines.image_url ∪ sessions.cover_photo_url ∪ the users tile
// columns ∪ every live Redis line-up and meta. A legacy WINE key is
// `wines/<stem>.<ext>` whose stem is EXACTLY 21 nanoid characters or all
// digits (a current-shape stem is `<id>_<nanoid8>`: 30 characters, or 22 for
// a digit id; a suffix test would miss a legacy id with `_` at index 12),
// matched to its wine by REFERENCE, never by id (the old Date.now() bug keyed
// some photos 50–500 ms off their wine's id). A legacy COVER is
// `sessions/(<4 hex>|<8 Crockford>)_<13 digits>.<ext>` (a nanoid16 can't
// satisfy `_\d{13}`). `sessions/new_<ts>_<rand>` (the create path between) is
// known and carries no code: listed, not re-keyed. Anything else is listed as
// unclassified, never touched.
//
// Dry run (default): nothing written. Counts per class, legacy keys referenced
// only from Redis without a live row (expected 0: their 48 h ran out), rows
// under a foreign endpoint prefix, referenced keys missing from the bucket,
// unreferenced legacy objects.
//
// --apply: moment by moment in a shuffled order. Per moment: a manifest line
// per key FIRST, CopyObject to the current shape (`wines/<id>_<nanoid8>`,
// `sessions/<nanoid16>`), then ONE session mutation contract (lock, advisory
// lock, `readMeta: 'optional'`: a cold cache is never rebuilt by the script):
//   - the bottles: RECORD-FIRST (catalogue model change § 8a) — a
//     compare-and-set of `wines.image_url` (`= old`) under the advisory lock,
//     a NULL line-up revision reconciled first, the revision bumped, and a
//     cached line-up re-projected from the record after COMMIT (stamped);
//   - the cover: a CAS of `sessions.cover_photo_url`; when meta is cached it is
//     re-written FROM THE RECORD after COMMIT (XX + KEEPTTL, as the settings
//     route does): no invalidation, no rebuild, no 503 for a live tasting;
//   - every users tile column holding one of those URLs, CAS'd.
// A concurrent edit wins (the CAS / transform misses; the copy stays
// unreferenced for the reclaim). Bottles of moments without a live row
// (deleted, D8 survivors): the plain row CAS, no contract. A guest-only
// (Redis-only) moment still referencing an old key: skipped and listed.
//
// --reclaim (days later, repeatable): deletes (a) a manifest's old key, (b) a
// legacy-shaped orphan older than the deploy that stopped minting that shape
// (D3), (c) a manifest's own LOSING copy (a current-shape key) only when older
// than 24 h (a fresh upload is briefly unreferenced: it uploads before its
// contract commits). Each is re-checked at delete time against every URL
// column (wines, sessions, users incl. image + tiles, rating_images) and the
// live Redis line-ups / metas (read at the start of the run). D8 holds: a
// photo a rating or bookmark references is MOVED, never removed.
//
// 🔒 The manifest pairs guessable old keys with unguessable new ones, and the
// cover keys contain JOIN CODES: it is a list of codes. OPERATOR-LOCAL, 0600,
// never committed, deleted after the reclaim; one --apply / --reclaim per
// manifest at a time (a lock file beside it).
// Runbook: docs/dev/deployment.md § Re-key session images.
import { existsSync, readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { canonicalManifest, lockManifest, appendManifest, ownerOnlyManifest, operatorManifestPath } from './rekey-user-images.mts'

type Mode = 'dry' | 'apply' | 'reclaim'
type Log = (o: Record<string, unknown>) => void
export type RunOpts = { mode: Mode; manifest: string; s3?: S3Client; bucket?: string; log?: Log; now?: number }

export const DEFAULT_MANIFEST = '.local/rekey/rekey-session-images.manifest.jsonl'
// The deploys that stopped minting each legacy shape (the merges of PR #103 and
// PR #113, plus two hours for the rollout): an orphan of that shape older than
// this is a leftover (D3).
export const LEGACY_CUTOFF = { wine: Date.parse('2026-11-08T20:20:07Z'), cover: Date.parse('2026-11-11T18:28:16Z') }
export const FRESH_MS = 24 * 3600 * 1000

const EXT = '(jpg|jpeg|png|webp|gif)'
const LEGACY_WINE = new RegExp(`^wines/([A-Za-z0-9_-]{21}|\\d+)\\.${EXT}$`)
const CURRENT_WINE = new RegExp(`^wines/([A-Za-z0-9_-]{21}|\\d+)_[A-Za-z0-9_-]{8}\\.${EXT}$`)
const LEGACY_COVER = new RegExp(`^sessions/([0-9A-F]{4}|[0-9A-HJKMNP-TV-Z]{8})_\\d{13}\\.${EXT}$`)
const NEW_COVER = new RegExp(`^sessions/new_\\d{13}_[0-9a-z]{1,8}\\.${EXT}$`)
const CURRENT_COVER = new RegExp(`^sessions/[A-Za-z0-9_-]{16}\\.${EXT}$`)

export type KeyClass = 'legacy-wine' | 'legacy-cover' | 'current-wine' | 'current-cover' | 'new-cover' | 'checkin' | 'unclassified'
// Legacy first, by EXACT stem length: a legacy 21-character stem that happens
// to read `<12 digits>_<8>` must stay legacy.
export function classifyKey(key: string): KeyClass {
  if (key.startsWith('wines/ci_')) return 'checkin'
  if (LEGACY_WINE.test(key)) return 'legacy-wine'
  if (CURRENT_WINE.test(key)) return 'current-wine'
  if (LEGACY_COVER.test(key)) return 'legacy-cover'
  if (NEW_COVER.test(key)) return 'new-cover'
  if (CURRENT_COVER.test(key)) return 'current-cover'
  return 'unclassified'
}
const isLegacy = (c: KeyClass) => c === 'legacy-wine' || c === 'legacy-cover'
const extOf = (key: string) => /\.([A-Za-z0-9]+)$/.exec(key)?.[1] ?? 'jpg'

const TILE_COLS = ['tile_impressions_url', 'tile_moments_url', 'tile_cravings_url', 'tile_impressions_own_url', 'tile_moments_own_url', 'tile_cravings_own_url'] as const
const USER_COLS = ['image_url', 'cover_photo_url', ...TILE_COLS] as const

export async function run(opts: RunOpts) {
  if (opts.mode === 'dry') return runModes(opts)
  const manifest = canonicalManifest(opts.manifest)
  const release = lockManifest(manifest)
  try { ownerOnlyManifest(manifest); return await runModes({ ...opts, manifest }) } finally { release() }
}

async function runModes(opts: RunOpts) {
  const [{ prisma }, { redis, k, scanKeys }, mut, rec, occ] = await Promise.all([
    import('../lib/prisma.ts'), import('../lib/redis.ts'), import('../lib/sessionMutation.ts'), import('../lib/sessionRecord.ts'), import('../lib/occurrences.ts'),
  ])
  const bucket = opts.bucket ?? process.env.S3_BUCKET
  const endpoint = process.env.S3_ENDPOINT
  if (!bucket) throw new Error('S3_BUCKET is not set')
  const s3 = opts.s3 ?? new S3Client({
    endpoint, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
  })
  const log: Log = opts.log ?? ((o) => console.log(JSON.stringify(o)))
  const now = opts.now ?? Date.now()
  const keyOf = (url: string | null | undefined) => { if (!url) return null; const at = url.indexOf(`/${bucket}/`); return at < 0 ? null : url.slice(at + bucket.length + 2) }
  const prefixOf = (url: string) => url.slice(0, url.indexOf(`/${bucket}/`) + bucket.length + 2)

  // ── the bucket listing ──────────────────────────────────────────────────────
  const listed = new Map<string, number>() // key → LastModified (ms; 0 = unknown)
  for (const prefix of ['wines/', 'sessions/']) {
    let token: string | undefined
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of page.Contents ?? []) if (o.Key && !o.Key.startsWith('wines/ci_')) listed.set(o.Key, o.LastModified ? new Date(o.LastModified).getTime() : 0)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }

  // ── the live Redis references (line-ups + metas) ────────────────────────────
  const redisRefs = new Map<string, Set<string>>() // key → codes
  const redisUrls = new Map<string, string>() // key → a stored URL (its prefix)
  const noteRedis = (url: string | undefined | null, code: string) => {
    const key = keyOf(url)
    if (!key) return
    const set = redisRefs.get(key) ?? new Set<string>()
    set.add(code); redisRefs.set(key, set); redisUrls.set(key, url!)
  }
  const codeOfKey = (key: string) => key.slice(2, key.lastIndexOf(':'))
  for (const key of await scanKeys('s:*:wines', { count: 1000, maxIterations: 100_000 })) {
    const raw = await redis.get(key)
    if (!raw) continue
    try { for (const w of JSON.parse(raw) as { imageUrl?: string }[]) noteRedis(w.imageUrl, codeOfKey(key)) } catch {}
  }
  for (const key of await scanKeys('s:*:meta', { count: 1000, maxIterations: 100_000 })) {
    const raw = await redis.get(key)
    if (!raw) continue
    try { noteRedis((JSON.parse(raw) as { coverPhotoUrl?: string }).coverPhotoUrl, codeOfKey(key)) } catch {}
  }

  // Which of `keys` a stored URL still names (any endpoint prefix: the key is
  // what follows `/<bucket>/`), in batches: one scan per URL column per batch,
  // so a reclaim of thousands of keys doesn't scan every column per key.
  const SEG = `/${bucket}/`
  const URL_COLS: [string, string][] = [['wines', 'image_url'], ['sessions', 'cover_photo_url'], ['rating_images', 'image_url'], ...USER_COLS.map(c => ['users', c] as [string, string])]
  const referencedAmong = async (keys: string[]): Promise<Set<string>> => {
    const hit = new Set(keys.filter(x => redisRefs.has(x)))
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500)
      for (const [t, col] of URL_COLS) {
        const rows = await prisma.$queryRawUnsafe<{ k: string }[]>(
          `SELECT DISTINCT substr(${col}, strpos(${col}, $1) + length($1)) AS k FROM ${t} WHERE strpos(${col}, $1) > 0 AND substr(${col}, strpos(${col}, $1) + length($1)) = ANY($2::text[])`, SEG, batch)
        for (const r of rows) hit.add(r.k)
      }
    }
    return hit
  }

  if (opts.mode === 'reclaim') {
    if (!existsSync(opts.manifest)) throw new Error(`no manifest at ${opts.manifest}`)
    const entries = readFileSync(opts.manifest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { old: string; new: string | null })
    const candidates = new Set<string>()
    for (const e of entries) candidates.add(e.old)
    for (const [key, mtime] of listed) {
      const c = classifyKey(key)
      if (c === 'legacy-wine' && mtime > 0 && mtime < LEGACY_CUTOFF.wine) candidates.add(key)
      if (c === 'legacy-cover' && mtime > 0 && mtime < LEGACY_CUTOFF.cover) candidates.add(key)
    }
    // A manifest's own copy is a candidate only once it is old enough to have
    // lost its race for good (and only if it is still unreferenced, below).
    for (const e of entries) {
      if (!e.new) continue
      const mtime = listed.get(e.new)
      if (mtime !== undefined && mtime > 0 && now - mtime > FRESH_MS) candidates.add(e.new)
    }
    let deleted = 0, kept = 0
    const present = [...candidates].filter(x => listed.has(x))
    // Re-checked at delete time, in batches (the Redis references were read at
    // the start of this run).
    for (let i = 0; i < present.length; i += 500) {
      const batch = present.slice(i, i + 500)
      const live = await referencedAmong(batch)
      for (const key of batch) {
        if (live.has(key)) { kept++; continue }
        try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); deleted++ } catch { kept++ }
      }
    }
    const summary = { mode: 'reclaim', entries: entries.length, candidates: candidates.size, deleted, kept }
    log(summary)
    return summary
  }

  // ── discovery: the record ───────────────────────────────────────────────────
  type WineRef = { wineId: string; url: string; sessionId: number | null; code: string | null; live: boolean }
  type CoverRef = { sessionId: number; url: string; code: string }
  const wineRefs = new Map<string, WineRef[]>()
  const coverRefs = new Map<string, CoverRef[]>()
  const tileRefs = new Map<string, string[]>() // key → stored URLs (users tile columns, rating_images)
  let foreign = 0
  const isForeign = (url: string) => !!endpoint && !url.startsWith(`${endpoint}/${bucket}/`)
  for (const r of await prisma.$queryRaw<{ id: string; image_url: string; session_id: number | null; code: string | null; deleted_at: Date | null }[]>`
    SELECT w.id, w.image_url, w.session_id, s.code, s.deleted_at FROM wines w LEFT JOIN sessions s ON s.id = w.session_id
     WHERE w.image_url IS NOT NULL AND w.image_url <> ''`) {
    const key = keyOf(r.image_url)
    if (!key || !isLegacy(classifyKey(key))) continue
    if (isForeign(r.image_url)) foreign++
    const list = wineRefs.get(key) ?? []
    list.push({ wineId: r.id, url: r.image_url, sessionId: r.session_id, code: r.code, live: !!r.code && r.deleted_at === null })
    wineRefs.set(key, list)
  }
  for (const r of await prisma.$queryRaw<{ id: number; code: string | null; cover_photo_url: string; deleted_at: Date | null }[]>`
    SELECT id, code, cover_photo_url, deleted_at FROM sessions WHERE cover_photo_url IS NOT NULL AND cover_photo_url <> ''`) {
    const key = keyOf(r.cover_photo_url)
    if (!key || !isLegacy(classifyKey(key)) || !r.code || r.deleted_at) continue
    if (isForeign(r.cover_photo_url)) foreign++
    const list = coverRefs.get(key) ?? []
    list.push({ sessionId: r.id, url: r.cover_photo_url, code: r.code })
    coverRefs.set(key, list)
  }
  for (const col of TILE_COLS) {
    for (const r of await prisma.$queryRawUnsafe<{ u: string }[]>(`SELECT ${col} AS u FROM users WHERE ${col} IS NOT NULL`)) {
      const key = keyOf(r.u)
      if (!key || !isLegacy(classifyKey(key))) continue
      const list = tileRefs.get(key) ?? []
      if (!list.includes(r.u)) list.push(r.u)
      tileRefs.set(key, list)
    }
  }
  // A check-in photo row naming a legacy-shaped key (current writers mint
  // `wines/ci_`; listed and moved all the same, with the plain CAS).
  for (const r of await prisma.$queryRaw<{ u: string }[]>`SELECT image_url AS u FROM rating_images WHERE image_url IS NOT NULL`) {
    const key = keyOf(r.u)
    if (!key || !isLegacy(classifyKey(key))) continue
    const list = tileRefs.get(key) ?? []
    if (!list.includes(r.u)) list.push(r.u)
    tileRefs.set(key, list)
  }
  const liveCodes = new Set((await prisma.$queryRaw<{ code: string }[]>`SELECT code FROM sessions WHERE code IS NOT NULL AND deleted_at IS NULL`).map(r => r.code))

  // Every legacy key in play: listed or referenced anywhere.
  const legacyKeys = new Set<string>()
  for (const key of listed.keys()) if (isLegacy(classifyKey(key))) legacyKeys.add(key)
  for (const m of [wineRefs, coverRefs, tileRefs]) for (const key of m.keys()) legacyKeys.add(key)
  for (const key of redisRefs.keys()) if (isLegacy(classifyKey(key))) legacyKeys.add(key)

  const byClass: Record<string, number> = {}
  for (const key of listed.keys()) { const c = classifyKey(key); byClass[c] = (byClass[c] ?? 0) + 1 }
  const unclassified = [...listed.keys()].filter(x => classifyKey(x) === 'unclassified')
  const redisOnly = [...legacyKeys].filter(x => redisRefs.has(x) && ![...redisRefs.get(x)!].some(c => liveCodes.has(c)) && !wineRefs.has(x) && !coverRefs.has(x))
  const isRef = (x: string) => wineRefs.has(x) || coverRefs.has(x) || tileRefs.has(x) || redisRefs.has(x)
  const missing = [...legacyKeys].filter(x => isRef(x) && !listed.has(x))
  const orphans = [...legacyKeys].filter(x => listed.has(x) && !isRef(x))
  const discovery = {
    listed: listed.size, byClass, unclassified: unclassified.length, legacyReferenced: [...legacyKeys].filter(isRef).length,
    redisOnlyNoRow: redisOnly.length, foreignPrefixRows: foreign, missingSources: missing.length, orphans: orphans.length,
  }
  if (opts.mode === 'dry') { log({ mode: 'dry', ...discovery }); return { mode: 'dry', ...discovery, unclassifiedKeys: unclassified } }

  // ── apply: group by moment ──────────────────────────────────────────────────
  type Swap = { old: string; next: string; kind: 'wine' | 'cover'; urls: Set<string> }
  const groups = new Map<string, Swap[]>() // live code → swaps
  const loose: Swap[] = [] // no live row: the plain row CAS
  const plan = new Map<string, Swap>()
  const swapFor = (key: string, kind: 'wine' | 'cover', idHint: string | null): Swap => {
    let sw = plan.get(key)
    if (!sw) {
      const stem = idHint ?? key.slice('wines/'.length, key.lastIndexOf('.'))
      let next = kind === 'wine' ? `wines/${stem}_${nanoid(8)}.${extOf(key)}` : `sessions/${nanoid(16)}.${extOf(key)}`
      // The new key must itself be current-shape (an id of an unexpected
      // length could make `<id>_<8>` read as a legacy 21-character stem).
      if (kind === 'wine' && classifyKey(next) !== 'current-wine') next = `wines/${nanoid()}_${nanoid(8)}.${extOf(key)}`
      sw = { old: key, next, kind, urls: new Set() }
      plan.set(key, sw)
    }
    return sw
  }
  const addTo = (code: string | null, sw: Swap) => {
    if (code && liveCodes.has(code)) { const g = groups.get(code) ?? []; if (!g.includes(sw)) g.push(sw); groups.set(code, g) }
    else if (!loose.includes(sw)) loose.push(sw)
  }
  for (const [key, refs] of wineRefs) {
    const sw = swapFor(key, 'wine', refs[0].wineId)
    for (const r of refs) { sw.urls.add(r.url); addTo(r.live ? r.code : null, sw) }
  }
  for (const [key, refs] of coverRefs) {
    const sw = swapFor(key, 'cover', null)
    for (const r of refs) { sw.urls.add(r.url); addTo(r.code, sw) }
  }
  const skippedRedisOnly: string[] = []
  for (const [key, codes] of redisRefs) {
    const c = classifyKey(key)
    if (!isLegacy(c)) continue
    const live = [...codes].filter(code => liveCodes.has(code))
    if (live.length === 0) { if (!plan.has(key)) skippedRedisOnly.push(key); continue }
    const sw = swapFor(key, c === 'legacy-wine' ? 'wine' : 'cover', null)
    sw.urls.add(redisUrls.get(key)!)
    for (const code of live) addTo(code, sw)
  }
  for (const [key, urls] of tileRefs) {
    if (plan.has(key)) { for (const u of urls) plan.get(key)!.urls.add(u); continue }
    const sw = swapFor(key, classifyKey(key) === 'legacy-wine' ? 'wine' : 'cover', null)
    for (const u of urls) sw.urls.add(u)
    addTo(null, sw)
  }

  const copied = new Set<string>()
  let copyFailed = 0
  const copy = async (sw: Swap): Promise<boolean> => {
    if (copied.has(sw.old)) return true
    appendManifest(opts.manifest, { old: sw.old, new: sw.next, kind: sw.kind })
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sw.old }))
      await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: sw.next, CopySource: `${bucket}/${sw.old}`, ContentType: head.ContentType, MetadataDirective: 'REPLACE' }))
      copied.add(sw.old)
      return true
    } catch { copyFailed++; return false }
  }
  // Every (old URL → new URL) pair of a swap (each stored URL keeps its prefix).
  const pairs = (sw: Swap) => [...sw.urls].map(u => [u, prefixOf(u) + sw.next] as const)
  // The users tile columns + rating_images holding one of a swap's URLs.
  const casOthers = async (tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> }, sw: Swap) => {
    let n = 0
    for (const [o, nu] of pairs(sw)) {
      for (const col of TILE_COLS) n += await tx.$executeRawUnsafe(`UPDATE users SET ${col} = $1 WHERE ${col} = $2`, nu, o)
      n += await tx.$executeRawUnsafe('UPDATE rating_images SET image_url = $1 WHERE image_url = $2', nu, o)
    }
    return n
  }

  let updatedRows = 0, lostRaces = 0, moments = 0, momentFailed = 0, warmLineups = 0, metaRewrites = 0
  const skippedUnreconciled: string[] = []
  const order = [...groups.keys()]
  for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]] }
  for (const code of order) {
    const swaps: Swap[] = []
    for (const sw of groups.get(code)!) if (await copy(sw)) swaps.push(sw)
    if (swaps.length === 0) continue
    const wineSwap = new Map<string, string>()
    const coverSwap = new Map<string, string>()
    for (const sw of swaps) for (const [o, nu] of pairs(sw)) (sw.kind === 'wine' ? wineSwap : coverSwap).set(o, nu)
    try {
      const out = await mut.withSessionMutation(code, { label: 'rekey-images', redisLock: { waitMs: 3000 }, readMeta: 'optional' }, async (tx, ctx) => {
        let n = 0, warm = false, coverChanged = false, unreconciled = false
        let lineup: { wines: unknown[]; revision: number } | null = null
        if (!ctx.row) return { n, warm, nextMeta: null as unknown, lineup, unreconciled }
        if (wineSwap.size && ctx.row.lineupRevision === null) {
          // An UNRECONCILED moment is skipped (review r1): reconciling here would
          // orphan record-only rows before Simon has read them, and a CAS on the
          // record alone would be undone by the reconciliation (the cache wins).
          // Run scripts/warm-lineups.mts --apply first, then this again.
          unreconciled = true
        } else if (wineSwap.size) {
          // RECORD-FIRST (catalogue model change § 8a): a compare-and-set of
          // wines.image_url (`= old`; a concurrent edit wins), the revision
          // bumped, the cached line-up projected from the record after COMMIT.
          let moved = 0
          for (const [o, nu] of wineSwap) moved += await tx.$executeRaw`UPDATE wines SET image_url = ${nu} WHERE session_id = ${ctx.row.id} AND image_url = ${o}`
          n += moved
          if (moved > 0) {
            const revision = await occ.bumpLineupRevision(tx, ctx.row.id)
            if (revision !== null && (await redis.exists(k.wines(code)))) { lineup = { wines: await occ.recordLineup(tx, ctx.row.id), revision }; warm = true }
          }
        }
        for (const [o, nu] of coverSwap) {
          const c = await tx.$executeRaw`UPDATE sessions SET cover_photo_url = ${nu} WHERE id = ${ctx.row.id} AND cover_photo_url = ${o}`
          n += c; if (c > 0) coverChanged = true
        }
        for (const sw of swaps) n += await casOthers(tx, sw)
        // The cover's meta FROM THE RECORD, re-read after the CAS (ctx.row still
        // holds the old URL); written in the projection. Also when the CAS lost
        // but the cached meta still names an old URL (a run that died between
        // its COMMIT and this projection): the record is the truth either way.
        const staleMeta = !!ctx.meta?.coverPhotoUrl && coverSwap.has(ctx.meta.coverPhotoUrl)
        const nextMeta = ctx.meta && (coverChanged || staleMeta) ? rec.metaFromRecord((await rec.readLiveRow(tx, code))!, await rec.readRecordRoles(tx, code), ctx.meta) : null
        return { n, warm, nextMeta, lineup, unreconciled }
      }, async (ctx, r) => {
        if (r.lineup) await occ.projectLineup(ctx.fence!, r.lineup.wines as never, r.lineup.revision)
        if (r.nextMeta) await ctx.fence!.exec(m => { m.set(k.meta(code), JSON.stringify(r.nextMeta), { XX: true, KEEPTTL: true }) })
      })
      moments++
      updatedRows += out.n
      if (out.warm) warmLineups++
      if (out.nextMeta) metaRewrites++
      if (out.unreconciled) { skippedUnreconciled.push(code); log({ code: 'skipped-unreconciled', moment: code }) }
      if (out.n === 0) lostRaces++
    } catch (err) {
      momentFailed++
      log({ code: 'moment-failed', error: err instanceof Error ? err.message : String(err) })
    }
  }
  // Bottles without a live moment (deleted moments' D8 survivors) and tiles
  // whose photo has no live row: the plain compare-and-set, no contract.
  for (const sw of loose) {
    if (!(await copy(sw))) continue
    const n = await prisma.$transaction(async (tx) => {
      let m = 0
      for (const [o, nu] of pairs(sw)) {
        if (sw.kind === 'wine') m += await tx.$executeRaw`UPDATE wines SET image_url = ${nu} WHERE image_url = ${o} AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE code IS NOT NULL AND deleted_at IS NULL))`
      }
      m += await casOthers(tx, sw)
      return m
    })
    updatedRows += n
    if (n === 0) lostRaces++
  }
  const summary = { mode: 'apply', ...discovery, moments, momentFailed, warmLineups, metaRewrites, copied: copied.size, copyFailed, updatedRows, lostRaces, skippedRedisOnly: skippedRedisOnly.length, skippedUnreconciled, manifest: opts.manifest }
  log(summary)
  return { ...summary, skippedRedisOnlyKeys: skippedRedisOnly }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const mode: Mode = args.includes('--reclaim') ? 'reclaim' : args.includes('--apply') ? 'apply' : 'dry'
  const mi = args.indexOf('--manifest')
  const manifest = mi >= 0 ? args[mi + 1] : DEFAULT_MANIFEST
  if (args.includes('--apply') && args.includes('--reclaim')) { console.error('--apply and --reclaim are separate runs'); process.exit(2) }
  let manifestPath: string
  try { manifestPath = operatorManifestPath(manifest, DEFAULT_MANIFEST) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(2) }
  run({ mode, manifest: manifestPath }).then(async () => {
    const [{ prisma }, { redis }] = await Promise.all([import('../lib/prisma.ts'), import('../lib/redis.ts')])
    await prisma.$disconnect().catch(() => {}); await redis.quit().catch(() => {})
    process.exit(0)
  }, (e) => { console.error('[rekey-sessions] failed:', e instanceof Error ? e.message : e); process.exit(1) })
}
