// You profile, steps 2 + 3 — integration suite (.local/you-profile/step2-plan.md
// + step3-plan.md § Verification). Drives the REAL route handlers and lib
// functions (tsx) against a throwaway Postgres + Redis:
//   § 1 bio normalisation + PATCH /api/me/profile (rename tail, validation)
//   § 2 tile pools + pins (PICK vs LIVE, D3 re-hide, D7 deleted moment, the
//       dead-pin clear, the clear vs a same-URL re-pick on the locked row)
//   § 3 D8: a moment deletion keeps rated / bookmarked wine photos
//   § 4 D9: account deletion (wiped moment two-phase, surviving moment keeps
//       every photo, rolled-back attempt reclaims nothing, avatar + cover)
//   § 5 the profile image replace protocol (no orphan under concurrency, a
//       replace blocked on an account deletion reclaims its own upload)
//   § 5b a tile's own photo (upload + pin, always live, reclaimed on replace /
//       re-pin / null / account deletion, a referenced photo never)
//   § 6 GET /api/me/mutes (shape, newest first, the blocked-me scrub both ways,
//       the cap, 401)
//   § 7 the devices routes for a NATIVE caller (This Device, the password-free
//       own-row revoke, the password gates, revoke-all keeps the caller)
//   § 8 Delete Account's failure premise: a refused deletion (409) leaves the
//       account intact with its native sessions ALREADY gone, so the app
//       signs itself out (step-3 plan T4)
//   § 9 the app's email change re-confirms the password
//   Step 4 (.local/you-profile/step4-plan.md § Verification):
//   § 10 (a) canViewPosts, the pure table (no DB)
//   § 11 (b) every post surface: one visible pair, one hidden pair, self;
//        places; tiles; like (D11); had a sip; badge dates; tighten-then-loosen
//   § 12 (c2) no payload a non-participant receives carries a moment code
//   § 13 (c) PATCH /api/me/visibility compare-and-set (409 + current, no-op
//        retry, 400s, charges, audit snapshot, the row LOCK)
//   § 14 (d) the checkin_visibility CHECK
//   § 15 the extended circle follows the tier (Followers of Followers /
//        Friends of Friends: four single-edge negatives + a one-way chain,
//        blocks break a link, single + bulk paths) and the shared
//        post-audience rule (@verre/core) against canViewPosts + on the
//        server's write
//   People + Add Friends (.local/you-profile/people-plan.md § Verification):
//   § 16 the people lists (block pairs both ways, never a count above its
//        rows, known + q + cursor, in common == knownCount, photo / xp /
//        friends in common by each person's own tier incl. the circle + self,
//        own-row nulls, the together predicate), tasted-with (exclusions
//        before the limit, both sort keys, a nameless moment), search (block
//        before the limit, the new fields, never yourself), the shell's followsYou, the
//        limiter keys
//   § 17 a moment's preview (guest / host / signed out / unknown, its own
//        budget never reset by a hit, a block pair hides the host id, 429)
//
// S3 is an in-process FAKE endpoint that records every PUT / DELETE the AWS
// SDK actually sends, so "reclaimed" / "survives" is observed on the wire,
// not inferred. CI has no S3; this needs none.
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/you-profile-integration.mts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerHooks } from 'node:module'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'

const HERE = dirname(fileURLToPath(import.meta.url))
// Logged-in actors authenticate through the REAL Better Auth branch of
// lib/resolveUser.ts; NextAuth's auth() can't read headers() outside Next.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: pathToFileURL(pjoin(HERE, 'stubs', 'nextauth-anonymous.mts')).href, shortCircuit: true }
    return next(specifier, context)
  },
})

// ── Guards ──────────────────────────────────────────────────────────────────
const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required (Better Auth)')

// ── Fake S3 (path-style: /<bucket>/<key>) ─────────────────────────────────────
const store = new Set<string>()
const puts: string[] = []
const deletes: string[] = []
const fake = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const key = decodeURIComponent(new URL(req.url ?? '/', 'http://s3').pathname).replace(/^\/verre\//, '')
    // CopyObject ("had a sip") is a PUT with x-amz-copy-source; the SDK needs the XML result.
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      store.add(key); puts.push(key); res.writeHead(200, { 'Content-Type': 'application/xml' })
      return res.end('<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"fake"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>')
    }
    if (req.method === 'PUT') { store.add(key); puts.push(key); res.writeHead(200, { ETag: '"fake"' }); return res.end() }
    if (req.method === 'DELETE') { store.delete(key); deletes.push(key); res.writeHead(204); return res.end() }
    res.writeHead(store.has(key) ? 200 : 404); res.end()
  })
})
await new Promise<void>(r => fake.listen(0, '127.0.0.1', r))
const S3 = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
// Before ANY module that reads them at load (lib/s3.ts, the inlined reclaims).
Object.assign(process.env, { S3_ENDPOINT: S3, S3_BUCKET: 'verre', S3_ACCESS_KEY: 'fake', S3_SECRET_KEY: 'fake', S3_REGION: 'us-east-1' })
const urlOf = (key: string) => `${S3}/verre/${key}`
const keyOf = (url: string | null | undefined) => (url ?? '').replace(`${S3}/verre/`, '')
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const { prisma } = await import('../../lib/prisma.ts')
const { redis, k, scanKeys } = await import('../../lib/redis.ts')
const { betterAuthServer } = await import('../../lib/betterAuth.ts')
const { normalizeBio, BIO_MAX } = await import('../../packages/core/src/index.ts')
const sessionRoute = await import('../../app/api/session/route.ts')
const codeRoute = await import('../../app/api/session/[code]/route.ts')
const joinRoute = await import('../../app/api/session/join/route.ts')
const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
const profileRoute = await import('../../app/api/me/profile/route.ts')
const photosRoute = await import('../../app/api/me/profile/photos/route.ts')
const avatarRoute = await import('../../app/api/me/avatar/route.ts')
const coverRoute = await import('../../app/api/me/cover/route.ts')
const tilesRoute = await import('../../app/api/me/profile/tiles/[tile]/route.ts')
const previewRoute = await import('../../app/api/session/[code]/preview/route.ts')
const usersRoute = await import('../../app/api/users/[id]/route.ts')
const mutesRoute = await import('../../app/api/me/mutes/route.ts')
const muteRoute = await import('../../app/api/me/mutes/[id]/route.ts')
const blockRoute = await import('../../app/api/me/blocks/[id]/route.ts')
const devicesRoute = await import('../../app/api/me/devices/route.ts')
const deviceRoute = await import('../../app/api/me/devices/[id]/route.ts')
const accountRoute = await import('../../app/api/me/account/route.ts')
const feedRoute = await import('../../app/api/feed/route.ts')
const likeRoute = await import('../../app/api/feed-items/[id]/like/route.ts')
const checkinsRoute = await import('../../app/api/checkins/route.ts')
const visibilityRoute = await import('../../app/api/me/visibility/route.ts')
const badgesRoute = await import('../../app/api/users/[id]/badges/route.ts')
const searchRoute = await import('../../app/api/users/search/route.ts')
const followersRoute = await import('../../app/api/users/[id]/followers/route.ts')
const followingRoute = await import('../../app/api/users/[id]/following/route.ts')
const tastedWithRoute = await import('../../app/api/me/tasted-with/route.ts')
const { canViewPosts, viewableProfiles } = await import('../../lib/profileVisibility.ts')
const { canonicalPostAudience, applyVisibilityChanges } = await import('../../packages/core/src/index.ts')
const { ensureBadgesSeedOnce } = await import('../../lib/badgeService.ts')
const { ALL_BADGES } = await import('../../lib/badges.ts')
const { resolveUser } = await import('../../lib/resolveUser.ts')
const { listPickable, resolveTilePhotos, isOwnTileUpload } = await import('../../lib/profileTiles.ts')
const { replaceProfileImage } = await import('../../lib/profileImage.ts')
const { deleteAccountDurable, executeAccountDelete, AccountDeleteTooManyWipesError } = await import('../../lib/accountDelete.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TAG = `yp-${Date.now()}`
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }
type Actor = { cookie?: string }
type User = { id: number; cookie: string; email: string; password: string }
const BASE = 'http://localhost:3000'
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (actor.cookie) headers.cookie = actor.cookie
  const req = new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) })
  let json: unknown = null
  try { json = await res.json() } catch {}
  return { status: res.status, json: json as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
}
let userSeq = 0
async function mkUser(name: string): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const password = `pw-${TAG}-${userSeq}`
  await betterAuthServer.api.signUpEmail({ body: { name, email, password } })
  const { headers } = await betterAuthServer.api.signInEmail({ body: { email, password }, returnHeaders: true })
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  return { id: row.id, cookie: (headers.get('set-cookie') ?? '').split(';')[0], email, password }
}
// Another native session for the same user (a second phone).
async function signInAgain(u: User): Promise<User> {
  await resetLimits()
  const { headers } = await betterAuthServer.api.signInEmail({ body: { email: u.email, password: u.password }, returnHeaders: true })
  return { ...u, cookie: (headers.get('set-cookie') ?? '').split(';')[0] }
}
const tokenOf = (u: User) => decodeURIComponent(u.cookie.split('=')[1] ?? '').split('.')[0]
const authenticates = async (u: User) => (await resolveUser(new NextRequest(`${BASE}/api/me/devices`, { headers: { cookie: u.cookie } })))?.user?.id === String(u.id)
const dateFrom = new Date(Date.now() + 3600_000).toISOString()
async function createSession(u: User, name = 'Hana Host') {
  await resetLimits()
  const r = await call(sessionRoute.POST, 'POST', '/api/session', u, { hostDisplayName: name, sessionName: `${TAG} moment`, dateFrom })
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.code as string
}
async function join(code: string, u: User) {
  await resetLimits()
  const r = await call(joinRoute.POST, 'POST', '/api/session/join', u, { code, displayName: 'Joiner' })
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
}
async function addWine(code: string, u: User, name: string) {
  await resetLimits()
  const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, u, { name, type: 'red', image: PNG }, { code })
  if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
  const id = r.json.id as string
  const [w] = await prisma.$queryRaw<{ image_url: string | null }[]>`SELECT image_url FROM wines WHERE id = ${id}`
  if (!w?.image_url) throw new Error(`wine ${id} has no mirrored image_url`)
  return { id, url: w.image_url }
}
async function rate(code: string, u: User, wineId: string) {
  const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, u, { wineId, score: 4, flavors: {}, notes: 'nice' }, { code })
  if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
}
const bookmark = (userId: number, wineId: string) => prisma.bookmark.create({ data: { userId, wineId } })
const deleteMoment = (code: string, u: User) => call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, u, undefined, { code })
const patchProfile = async (u: User, body: unknown) => { await resetLimits(); return call(profileRoute.PATCH, 'PATCH', '/api/me/profile', u, body) }
async function getProfile(id: number, viewer: User) {
  await resetLimits()
  const r = await call(usersRoute.GET, 'GET', `/api/users/${id}?view=header`, viewer, undefined, { id: String(id) })
  if (r.status !== 200) throw new Error(`profile GET ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const pins = async (id: number) => (await prisma.$queryRaw<{ i: string | null; m: string | null; c: string | null }[]>`
  SELECT tile_impressions_url AS i, tile_moments_url AS m, tile_cravings_url AS c FROM users WHERE id = ${id}`)[0]
// Fire-and-forget reclaims: wait until the store settles on the expectation.
async function settled(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await sleep(50) }
  return pred()
}
function gate() { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }
async function stillPending(p: Promise<unknown>, ms = 100): Promise<boolean> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await sleep(ms)
  return !done
}
// Pending AND a backend of this database waits on a lock.
async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (!(await stillPending(p))) return false
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(n) > 0) return stillPending(p)
  }
  return false
}

// At least `n` backends of this database wait on a lock while `ps` are pending.
async function lockWaiters(n: number, ps: Promise<unknown>[]): Promise<boolean> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    for (const p of ps) if (!(await stillPending(p, 20))) return false
    const [{ c }] = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(c) >= n) return true
    await sleep(30)
  }
  return false
}

try {
  // ── § 1 Bio + PATCH /api/me/profile ───────────────────────────────────────
  section('§ 1 bio normalisation + PATCH /api/me/profile')
  check('whitespace runs (newlines included) become one space, trimmed', normalizeBio('  a \n\n b\t c  ') === 'a b c')
  check('empty / invisible-only / null → null', normalizeBio('') === null && normalizeBio('​ \n') === null && normalizeBio(null) === null)
  const deva = 'x'.repeat(BIO_MAX - 1) + 'क़'
  check('no NFC: U+0958 at the 200-unit boundary passes UNCHANGED (NFC would make it 201)', normalizeBio(deva) === deva)
  check('100 emoji (200 UTF-16 units) pass; one more unit throws', normalizeBio('😀'.repeat(100)) === '😀'.repeat(100) && (() => { try { normalizeBio('😀'.repeat(100) + 'a'); return false } catch { return true } })())
  check('trailing whitespace past the limit is trimmed, not rejected', normalizeBio('a'.repeat(BIO_MAX) + '   ') === 'a'.repeat(BIO_MAX))

  const P = await mkUser('Pia Profile')
  const V = await mkUser('Vic Viewer')
  const M1 = await createSession(P, 'Pia Profile')
  let r = await patchProfile(P, { name: 'Pia Renamed', bio: deva })
  check('PATCH name + bio → 200 with the changed fields', r.status === 200 && r.json.name === 'Pia Renamed' && r.json.bio === deva, r)
  const [u1] = await prisma.$queryRaw<{ name: string; bio: string }[]>`SELECT name, bio FROM users WHERE id = ${P.id}`
  check('stored: VARCHAR(200) holds the boundary bio', u1.name === 'Pia Renamed' && u1.bio === deva)
  const [m1row] = await prisma.$queryRaw<{ host_name: string }[]>`SELECT host_name FROM sessions WHERE code = ${M1}`
  check('rename tail: hosted moment host_name mirrored', m1row.host_name === 'Pia Renamed', m1row)
  check('rename tail: live roster entry renamed', (await redis.hGet(k.identities(M1), `u:${P.id}`)) === 'Pia Renamed')
  r = await patchProfile(P, { bio: '  \n ' })
  check('whitespace-only bio clears to null', r.status === 200 && r.json.bio === null && (await prisma.user.findUnique({ where: { id: P.id }, select: { bio: true } }))?.bio === null, r)
  check('bio over the limit → 400', (await patchProfile(P, { bio: 'a'.repeat(BIO_MAX + 1) })).status === 400)
  check('invalid name → 400', (await patchProfile(P, { name: 'x' })).status === 400)
  check('unknown tile key → 400', (await patchProfile(P, { tiles: { bogus: null } })).status === 400)
  check('a URL outside the pool → 400', (await patchProfile(P, { tiles: { impressions: urlOf('wines/nope.png') } })).status === 400)
  r = await patchProfile(P, {})
  check('nothing to change → 200 {}', r.status === 200 && Object.keys(r.json).length === 0)

  // ── § 2 Tile pools + pins ─────────────────────────────────────────────────
  section('§ 2 tile pools + pins')
  const blind = await addWine(M1, P, 'Blind Bottle')
  await rate(M1, P, blind.id)
  await bookmark(P.id, blind.id)
  const M2 = await createSession(P, 'Pia Renamed')
  const vis = await addWine(M2, P, 'Open Bottle')
  await rate(M2, P, vis.id)
  await bookmark(P.id, vis.id)
  const cover1 = urlOf(`sessions/${TAG}-c1.png`), cover2 = urlOf(`sessions/${TAG}-c2.png`)
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${cover1}, blind = true WHERE code = ${M1}`
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${cover2} WHERE code = ${M2}`
  await prisma.$executeRaw`UPDATE wines SET revealed_at = NULL WHERE id = ${blind.id}`

  check('impressions PICK excludes the unrevealed blind wine', JSON.stringify(await listPickable('impressions', P.id, 60)) === JSON.stringify([vis.url]))
  check('cravings PICK excludes it too', JSON.stringify(await listPickable('cravings', P.id, 60)) === JSON.stringify([vis.url]))
  const mPick = await listPickable('moments', P.id, 60)
  check('moments PICK = every cover, the blind moment included (no wine predicate)', mPick.length === 2 && mPick[0] === cover2 && mPick.includes(cover1), mPick)
  // A code joins, and the tile is served outside the moment: a cover keyed by
  // the code (the old create + settings key shape) is never a tile photo.
  const coded = urlOf(`sessions/${M1}_${Date.now()}`)
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${coded} WHERE code = ${M1}`
  check('moments PICK never offers a cover whose URL carries the code', !(await listPickable('moments', P.id, 60)).includes(coded))
  check('pinning a code-bearing cover → 400', (await patchProfile(P, { tiles: { moments: coded } })).status === 400)
  await prisma.$executeRaw`UPDATE users SET tile_moments_url = ${coded} WHERE id = ${P.id}`
  const viaPin = await getProfile(P.id, V)
  const pinLeft = (await prisma.$queryRaw<{ u: string | null }[]>`SELECT tile_moments_url AS u FROM users WHERE id = ${P.id}`)[0].u
  check('an EXISTING pin on a code-bearing cover is never served, and is cleared', viaPin.tiles.moments.imageUrl !== coded && pinLeft === null, { tile: viaPin.tiles.moments, pinLeft })
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${cover1} WHERE code = ${M1}`
  let own = await getProfile(P.id, P)
  check('own GET: counts are every impression / bookmark / membership', own.tiles.impressions.count === 2 && own.tiles.cravings.count === 2 && own.tiles.moments.count === 2, own.tiles)
  check('own GET: automatic photos = latest pickable, pinned false', own.tiles.impressions.imageUrl === vis.url && own.tiles.impressions.pinned === false && own.tiles.moments.imageUrl === cover2, own.tiles)
  check('own GET carries bio + coverPhotoUrl', 'bio' in own && 'coverPhotoUrl' in own)
  check('pinning the unrevealed blind photo → 400', (await patchProfile(P, { tiles: { impressions: blind.url } })).status === 400)
  await prisma.$executeRaw`UPDATE wines SET revealed_at = now() WHERE id = ${blind.id}`
  r = await patchProfile(P, { tiles: { impressions: blind.url, moments: cover2, cravings: vis.url } })
  check('pin after reveal → 200, response carries the resolved tiles', r.status === 200 && r.json.tiles?.impressions?.imageUrl === blind.url && r.json.tiles?.impressions?.pinned === true && r.json.tiles?.moments?.pinned === true, r.json)
  await prisma.$executeRaw`UPDATE wines SET revealed_at = NULL WHERE id = ${blind.id}`
  own = await getProfile(P.id, P)
  check('D3: a blind re-hide does NOT drop the pin', own.tiles.impressions.imageUrl === blind.url && own.tiles.impressions.pinned === true)
  const other = await getProfile(P.id, V)
  check('another viewer sees the pin, without a `pinned` flag', other.tiles.impressions.imageUrl === blind.url && !('pinned' in other.tiles.impressions), other.tiles)
  await resetLimits()
  const picker = await call(photosRoute.GET, 'GET', '/api/me/profile/photos?pool=impressions', P)
  check('picker: the re-hidden pin is not offered (pin null, not in photos)', picker.status === 200 && picker.json.pin === null && !picker.json.photos.includes(blind.url), picker.json)
  const pickerM = await call(photosRoute.GET, 'GET', '/api/me/profile/photos?pool=moments', P)
  check('picker: a pickable pin comes first', pickerM.json.pin === cover2 && pickerM.json.photos[0] === cover2, pickerM.json)
  check('counts unchanged by pins / blind state', own.tiles.impressions.count === 2 && own.tiles.cravings.count === 2)

  const del2 = await deleteMoment(M2, P)
  check('moment M2 deleted', del2.status === 200, del2)
  own = await getProfile(P.id, P)
  check('D7: the deleted moment\'s impression photo is still pickable', (await listPickable('impressions', P.id, 60)).includes(vis.url))
  check('D7: the cravings pin on its (bookmarked) wine survives', own.tiles.cravings.imageUrl === vis.url && own.tiles.cravings.pinned === true)
  check('Moments pin on the deleted moment drops → automatic M1 cover', own.tiles.moments.imageUrl === cover1 && own.tiles.moments.pinned === false && own.tiles.moments.count === 1, own.tiles.moments)
  check('…and the dead pin is CLEARED in the row', (await pins(P.id)).m === null)

  await prisma.$executeRaw`DELETE FROM ratings WHERE user_id = ${P.id} AND wine_id = ${blind.id}`
  own = await getProfile(P.id, P)
  check('deleting the impression drops + clears its pin → automatic photo', own.tiles.impressions.imageUrl === vis.url && own.tiles.impressions.pinned === false && (await pins(P.id)).i === null, own.tiles.impressions)

  const replaced = urlOf(`wines/${vis.id}-v2.png`)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${replaced} WHERE id = ${vis.id}`
  own = await getProfile(P.id, P)
  check('replacing the wine photo drops + clears the cravings pin', own.tiles.cravings.imageUrl === replaced && own.tiles.cravings.pinned === false && (await pins(P.id)).c === null, own.tiles.cravings)

  check('re-pin the replaced photo', (await patchProfile(P, { tiles: { cravings: replaced } })).status === 200)
  await prisma.bookmark.deleteMany({ where: { userId: P.id, wineId: vis.id } })
  await getProfile(P.id, P)
  await bookmark(P.id, vis.id)
  own = await getProfile(P.id, P)
  check('un-save → read → re-save: the pin stays cleared', own.tiles.cravings.pinned === false && (await pins(P.id)).c === null)

  // The dead-pin clear vs a same-URL re-pick that commits while the clear
  // waits on the users-row lock: the fresh re-check must see the re-pick.
  check('re-pin once more', (await patchProfile(P, { tiles: { cravings: replaced } })).status === 200)
  await prisma.bookmark.deleteMany({ where: { userId: P.id, wineId: vis.id } })
  const { Client } = await import('pg')
  const holder = new Client({ connectionString: DB })
  await holder.connect()
  await holder.query('BEGIN')
  await holder.query('INSERT INTO bookmarks (user_id, wine_id) VALUES ($1, $2)', [P.id, vis.id])
  await holder.query('UPDATE users SET tile_cravings_url = $1 WHERE id = $2', [replaced, P.id])
  const read = resolveTilePhotos(P.id, ['impressions', 'moments', 'cravings'])
  check('the profile read blocks on the re-pick\'s row lock', await blockedOnLock(read))
  await holder.query('COMMIT')
  await holder.end()
  const after = await read
  check('…and keeps the re-picked pin (no erase)', after.cravings.imageUrl === replaced && after.cravings.pinned === true && (await pins(P.id)).c === replaced, after.cravings)

  // ── § 3 D8: moment deletion keeps photos still in use ─────────────────────
  section('§ 3 D8: session DELETE keeps rated / bookmarked wine photos')
  const H = await mkUser('Hal Host')
  const B = await mkUser('Bea Taster')
  const M3 = await createSession(H, 'Hal Host')
  await join(M3, B)
  const rated = await addWine(M3, H, 'Rated')
  const unused = await addWine(M3, H, 'Unused')
  const saved = await addWine(M3, H, 'Saved')
  await rate(M3, B, rated.id)
  await bookmark(B.id, saved.id)
  check('all three photos uploaded', [rated, unused, saved].every(w => store.has(keyOf(w.url))))
  const d3 = await deleteMoment(M3, H)
  check('moment deleted', d3.status === 200, d3)
  check('the unrated, unbookmarked photo is reclaimed', await settled(() => !store.has(keyOf(unused.url))))
  check('the RATED (unbookmarked) photo survives', store.has(keyOf(rated.url)))
  check('the bookmarked photo survives', store.has(keyOf(saved.url)))

  // ── § 4 D9: account deletion ──────────────────────────────────────────────
  section('§ 4 D9: account deletion')
  const H2 = await mkUser('Hugo Host')
  const B2 = await mkUser('Bo Taster')
  const W = await createSession(H2, 'Hugo Host')
  const w1 = await addWine(W, H2, 'Host Rated')
  const w2 = await addWine(W, H2, 'Host Saved')
  const w3 = await addWine(W, H2, 'Other Saved')
  const w4 = await addWine(W, H2, 'Nobody')
  await rate(W, H2, w1.id)
  await bookmark(H2.id, w2.id)
  await bookmark(B2.id, w3.id)
  const S = await createSession(H2, 'Hugo Host')
  await join(S, B2)
  const s1 = await addWine(S, H2, 'Survivor Rated')
  const s2 = await addWine(S, H2, 'Survivor Unrated')
  await rate(S, B2, s1.id)
  const av = await replaceProfileImage(H2.id, 'avatar', PNG)
  const cv = await replaceProfileImage(H2.id, 'cover', PNG)
  check('avatar + cover uploaded through the replace protocol', av.ok && cv.ok && store.has(keyOf(av.ok ? av.url : '')) && store.has(keyOf(cv.ok ? cv.url : '')))

  const before = deletes.length
  const reclaimedRb: string[] = []
  const rb = await deleteAccountDurable(H2.id, { hooks: { beforeUserDelete: async () => { throw new Error('injected failure') }, onReclaim: u => reclaimedRb.push(u) } })
    .then(() => 'committed', (e: Error) => e.message)
  await sleep(300)
  check('a rolled-back attempt reclaims nothing', rb === 'injected failure' && reclaimedRb.length === 0 && deletes.length === before, { rb, reclaimedRb })
  check('…and the account + its empty moment are intact', !!(await prisma.user.findUnique({ where: { id: H2.id } })) && (await prisma.session.count({ where: { code: W, deletedAt: null } })) === 1)

  const reclaimed: string[] = []
  await deleteAccountDurable(H2.id, { hooks: { onReclaim: u => reclaimed.push(u) } })
  const set = new Set(reclaimed)
  check('wiped moment: host-only rated + host-only bookmarked + unused photos reclaimed', set.has(w1.url) && set.has(w2.url) && set.has(w4.url), reclaimed)
  check('wiped moment: a photo another taster bookmarked is kept', !set.has(w3.url))
  check('surviving moment: EVERY wine photo kept (rated and unrated)', !set.has(s1.url) && !set.has(s2.url))
  check('profile photo + cover reclaimed', av.ok && cv.ok && set.has(av.url!) && set.has(cv.url!))
  check('on the wire: exactly those objects are gone', await settled(() =>
    [w1, w2, w4].every(w => !store.has(keyOf(w.url))) && [w3, s1, s2].every(w => store.has(keyOf(w.url)))
    && av.ok && cv.ok && !store.has(keyOf(av.url)) && !store.has(keyOf(cv.url))))

  // ── § 5 Replace protocol ──────────────────────────────────────────────────
  section('§ 5 profile image replace protocol')
  const Q = await mkUser('Quinn Replace')
  const prefix = `avatars/u_${Q.id}_`
  const results = await Promise.all([1, 2, 3, 4].map(() => replaceProfileImage(Q.id, 'avatar', PNG)))
  const qPuts = puts.filter(p => p.startsWith(prefix))
  const [{ image_url: finalAvatar }] = await prisma.$queryRaw<{ image_url: string | null }[]>`SELECT image_url FROM users WHERE id = ${Q.id}`
  const live = [...store].filter(p => p.startsWith(prefix))
  check('4 concurrent replaces: 4 distinct keys uploaded', results.every(x => x.ok) && new Set(qPuts).size === 4, qPuts)
  check('…exactly ONE object left, the one the row points at (no orphan)', live.length === 1 && urlOf(live[0]) === finalAvatar, { live, finalAvatar })
  await resetLimits()
  let rr = await call(avatarRoute.POST, 'POST', '/api/me/avatar', Q, { imageData: PNG })
  check('avatar route: same wire contract { imageUrl }, prior reclaimed', rr.status === 200 && typeof rr.json.imageUrl === 'string' && !store.has(keyOf(finalAvatar)), rr)
  rr = await call(avatarRoute.DELETE, 'DELETE', '/api/me/avatar', Q)
  check('avatar DELETE → { ok }, nothing of Q\'s avatars left', rr.status === 200 && rr.json.ok === true && ![...store].some(p => p.startsWith(prefix)))
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: PNG })
  const firstCover = rr.json.coverPhotoUrl as string
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: PNG })
  check('cover route: { coverPhotoUrl } under avatars/cover_u_<id>_, the replaced one reclaimed', rr.status === 200 && keyOf(rr.json.coverPhotoUrl).startsWith(`avatars/cover_u_${Q.id}_`) && !store.has(keyOf(firstCover)) && store.has(keyOf(rr.json.coverPhotoUrl)), rr)
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: 'data:text/plain;base64,aGk=' })
  check('a rejected (non-image) upload → 500, the stored cover unchanged', rr.status === 500 && (await prisma.user.findUnique({ where: { id: Q.id }, select: { coverPhotoUrl: true } }))?.coverPhotoUrl !== null)

  const Q2 = await mkUser('Quill Gone')
  const g = gate()
  let atHook = false
  const del = deleteAccountDurable(Q2.id, { hooks: { beforeUserDelete: async () => { atHook = true; await g.p } } })
  for (let i = 0; !atHook && i < 500; i++) await sleep(20)
  if (!atHook) throw new Error('account deletion never reached beforeUserDelete')
  const late = replaceProfileImage(Q2.id, 'cover', PNG)
  check('a replace racing the account deletion blocks on the users-row lock', await blockedOnLock(late))
  g.open()
  await del
  const lr = await late
  const lateKeys = puts.filter(p => p.startsWith(`avatars/cover_u_${Q2.id}_`))
  check('…finds no row and reclaims its OWN upload', !lr.ok && lr.reason === 'gone' && lateKeys.length === 1 && !store.has(lateKeys[0]), { lr, lateKeys })

  // ── § 5b a tile's own photo ───────────────────────────────────────────────
  section('§ 5b a tile\'s own photo: upload, always live, reclaimed only when owned')
  const T = await mkUser('Tilda Tiles')
  const ownKey = (k: string) => isOwnTileUpload(urlOf(k), 'impressions', T.id)
  check('isOwnTileUpload: this tile + this user, the last path segment only', ownKey(`avatars/tile_impressions_u_${T.id}_1_ab.png`) && !ownKey(`avatars/tile_impressions_u_${T.id}5_1_ab.png`) && !ownKey(`avatars/tile_moments_u_${T.id}_1_ab.png`) && !ownKey(`avatars/tile_impressions_u_${T.id}_/x.png`) && !isOwnTileUpload(null, 'impressions', T.id))
  const postTile = async (u: User, tile: string, imageData = PNG) => { await resetLimits(); return call(tilesRoute.POST, 'POST', `/api/me/profile/tiles/${tile}`, u, { imageData }, { tile }) }
  let tr = await postTile(T, 'impressions')
  const own1 = tr.json.tiles?.impressions?.imageUrl as string
  check('upload → 200, pinned, keyed avatars/tile_impressions_u_<id>_', tr.status === 200 && tr.json.tiles.impressions.pinned === true && keyOf(own1).startsWith(`avatars/tile_impressions_u_${T.id}_`) && store.has(keyOf(own1)) && (await pins(T.id)).i === own1, tr.json)
  const tp = await getProfile(T.id, T)
  check('shown with an EMPTY pool: always live, never cleared as dead', tp.tiles.impressions.imageUrl === own1 && tp.tiles.impressions.pinned === true && (await pins(T.id)).i === own1, tp.tiles.impressions)
  check('another viewer sees it too', (await getProfile(T.id, V)).tiles.impressions.imageUrl === own1)
  await resetLimits()
  const pk = await call(photosRoute.GET, 'GET', '/api/me/profile/photos?pool=impressions', T)
  check('picker: the own photo is the pin, listed first', pk.json.pin === own1 && pk.json.photos[0] === own1, pk.json)
  tr = await postTile(T, 'impressions')
  const own2 = tr.json.tiles?.impressions?.imageUrl as string
  check('a second upload replaces it; the first is reclaimed', tr.status === 200 && own2 !== own1 && !store.has(keyOf(own1)) && store.has(keyOf(own2)))
  const Mt = await createSession(T, 'Tilda night')
  const wt = await addWine(Mt, T, 'Tile Bottle')
  await rate(Mt, T, wt.id)
  r = await patchProfile(T, { tiles: { impressions: wt.url } })
  check('pinning one of your photos over it → 200, the own upload reclaimed', r.status === 200 && !store.has(keyOf(own2)) && (await pins(T.id)).i === wt.url, r.json)
  tr = await postTile(T, 'impressions')
  const own3 = tr.json.tiles?.impressions?.imageUrl as string
  check('🔒 uploading over a REFERENCE pin never reclaims the referenced photo', tr.status === 200 && store.has(keyOf(wt.url)) && (await pins(T.id)).i === own3)
  tr = await postTile(T, 'moments')
  const ownM = tr.json.tiles?.moments?.imageUrl as string
  r = await patchProfile(T, { tiles: { moments: null } })
  check('back to automatic (null) reclaims the own upload', r.status === 200 && !store.has(keyOf(ownM)) && (await pins(T.id)).m === null && r.json.tiles?.moments?.pinned === false, r.json)
  check('🔒 nobody can pin another person\'s own upload (not in their pool) → 400', (await patchProfile(V, { tiles: { impressions: own3 } })).status === 400)
  check('an unknown tile → 404', (await postTile(T, 'friends')).status === 404)
  tr = await postTile(T, 'impressions', 'data:text/plain;base64,aGk=')
  check('a rejected (non-image) upload → 500, the pin unchanged', tr.status === 500 && (await pins(T.id)).i === own3)
  await patchProfile(T, { tiles: { impressions: wt.url } })
  r = await patchProfile(T, { tiles: { impressions: null } })
  check('🔒 a REFERENCE pin cleared by the PATCH keeps its photo', r.status === 200 && store.has(keyOf(wt.url)) && !store.has(keyOf(own3)) && (await pins(T.id)).i === null)
  tr = await postTile(T, 'impressions')
  const own4 = tr.json.tiles?.impressions?.imageUrl as string
  tr = await postTile(T, 'cravings')
  const ownC = tr.json.tiles?.cravings?.imageUrl as string
  const reclaimedT: string[] = []
  await deleteAccountDurable(T.id, { hooks: { onReclaim: u => reclaimedT.push(u) } })
  check('account deletion reclaims every own tile upload', reclaimedT.includes(own4) && reclaimedT.includes(ownC) && !store.has(keyOf(own4)) && !store.has(keyOf(ownC)), reclaimedT)

  // ── § 6 GET /api/me/mutes ─────────────────────────────────────────────────
  section('§ 6 GET /api/me/mutes')
  const M = await mkUser('Mia Muter')
  const m1 = await mkUser('Mo First')
  const m2 = await mkUser('Max Second')
  const m3 = await mkUser('Mel BlocksMe')
  const m4 = await mkUser('Moe IBlocked')
  for (const t of [m1, m2, m3, m4]) {
    await resetLimits()
    const r = await call(muteRoute.POST, 'POST', `/api/me/mutes/${t.id}`, M, undefined, { id: String(t.id) })
    if (r.status !== 200) throw new Error(`mute ${r.status}`)
    await sleep(5)
  }
  const blockedMe = await call(blockRoute.POST, 'POST', `/api/me/blocks/${M.id}`, m3, undefined, { id: String(M.id) })
  const iBlocked = await call(blockRoute.POST, 'POST', `/api/me/blocks/${m4.id}`, M, undefined, { id: String(m4.id) })
  check('fixture: both blocks land', blockedMe.status === 200 && iBlocked.status === 200, [blockedMe.status, iBlocked.status])
  await resetLimits()
  const ml = await call(mutesRoute.GET, 'GET', '/api/me/mutes', M)
  const ids = (ml.json?.mutes ?? []).map((m: { id: number }) => m.id)
  check('200 with { mutes: [{ id, name, createdAt }] }, no imageUrl', ml.status === 200 && ml.json.mutes.every((m: Record<string, unknown>) => typeof m.id === 'number' && typeof m.name === 'string' && typeof m.createdAt === 'string' && !('imageUrl' in m)), ml.json)
  check('🔒 a muted user who BLOCKED me is left out', !ids.includes(m3.id), ids)
  check('one I blocked stays', ids.includes(m4.id), ids)
  check('newest first', JSON.stringify(ids) === JSON.stringify([m4.id, m2.id, m1.id]), ids)
  check('names come through', ml.json.mutes.find((m: { id: number }) => m.id === m1.id)?.name === 'Mo First')
  const anon = await call(mutesRoute.GET, 'GET', '/api/me/mutes', {})
  check('401 without a session', anon.status === 401)
  // The cap: 1001 muted users, seeded in SQL.
  await prisma.$executeRaw`INSERT INTO users (name, email) SELECT 'Cap ' || g, ${TAG} || '-cap-' || g || '@example.test' FROM generate_series(1, 1001) g`
  await prisma.$executeRaw`INSERT INTO user_mutes (muter_id, muted_id) SELECT ${M.id}, id FROM users WHERE email LIKE ${`${TAG}-cap-%`}`
  await resetLimits()
  const capped = await call(mutesRoute.GET, 'GET', '/api/me/mutes', M)
  check('capped at 1000 rows', capped.status === 200 && capped.json.mutes.length === 1000, capped.json?.mutes?.length)

  // ── § 7 devices, native caller ────────────────────────────────────────────
  section('§ 7 devices routes for a native caller')
  const D1 = await mkUser('Dee Devices')
  const D2 = await signInAgain(D1)
  const D3 = await signInAgain(D1)
  const rowOf = async (u: User) => (await prisma.authSession.findFirstOrThrow({ where: { token: tokenOf(u) }, select: { id: true } })).id
  const [d1Id, d2Id, d3Id] = [await rowOf(D1), await rowOf(D2), await rowOf(D3)]
  await resetLimits()
  const dl = await call(devicesRoute.GET, 'GET', '/api/me/devices', D1)
  const flagged = (dl.json?.devices ?? []).filter((d: { isCurrent: boolean }) => d.isCurrent).map((d: { id: string }) => d.id)
  check('GET flags exactly the caller\'s own ba: row as This Device', dl.status === 200 && JSON.stringify(flagged) === JSON.stringify([`ba:${d1Id}`]), flagged)
  await resetLimits()
  const noPw = await call(deviceRoute.DELETE, 'DELETE', `/api/me/devices/ba:${d2Id}`, D1, {}, { id: `ba:${d2Id}` })
  check('another device without a password → 403', noPw.status === 403 && (await authenticates(D2)), noPw)
  await resetLimits()
  const foreign = await call(deviceRoute.DELETE, 'DELETE', `/api/me/devices/ba:${await rowOf(M)}`, D1, { password: D1.password }, { id: `ba:${await rowOf(M)}` })
  check('someone else\'s ba: row (with my password) → 404, untouched', foreign.status === 404 && (await authenticates(M)), foreign)
  await resetLimits()
  const ownRow = await call(deviceRoute.DELETE, 'DELETE', `/api/me/devices/ba:${d3Id}`, D3, undefined, { id: `ba:${d3Id}` })
  check('my OWN ba: row needs no password → 200, and the session is dead', ownRow.status === 200 && !(await authenticates(D3)), ownRow)
  const D4 = await signInAgain(D1)
  await prisma.userSession.create({ data: { userId: D1.id, deviceLabel: 'MacBook · Safari' } })
  const webRow = await prisma.userSession.create({ data: { userId: D1.id, deviceLabel: 'Windows · Edge' }, select: { id: true } })
  await resetLimits()
  const webNoPw = await call(deviceRoute.DELETE, 'DELETE', `/api/me/devices/${webRow.id}`, D1, {}, { id: webRow.id })
  check('🔒 a web row without a password from the app → 403 (no web row is ever the app\'s own)', webNoPw.status === 403 && !(await prisma.userSession.findUniqueOrThrow({ where: { id: webRow.id } })).revokedAt, webNoPw)
  await resetLimits()
  const allNoPw = await call(devicesRoute.DELETE, 'DELETE', '/api/me/devices', D1, {})
  check('revoke-all without a password → 403 (not the old native 401)', allNoPw.status === 403 && (await authenticates(D2)), allNoPw)
  await resetLimits()
  const all = await call(devicesRoute.DELETE, 'DELETE', '/api/me/devices', D1, { password: D1.password })
  const web = await prisma.userSession.findMany({ where: { userId: D1.id }, select: { revokedAt: true, revocationReason: true } })
  check('revoke-all with the password → 200, `revoked` = the web rows', all.status === 200 && all.json?.revoked === 2, all)
  check('…keeps the caller', await authenticates(D1))
  check('…signs out every other phone', !(await authenticates(D2)) && !(await authenticates(D4)) && (await prisma.authSession.count({ where: { userId: D1.id } })) === 1)
  check('…revokes every web session (reason revoke_all)', web.length === 2 && web.every(w => w.revokedAt && w.revocationReason === 'revoke_all'), web)
  await resetLimits()
  const left = await call(devicesRoute.GET, 'GET', '/api/me/devices', D1)
  check('…and the list is just This Device', left.json?.devices?.length === 1 && left.json.devices[0].id === `ba:${d1Id}` && left.json.devices[0].isCurrent === true, left.json)

  // ── § 8 Delete Account failure premise ────────────────────────────────────
  section('§ 8 a refused account deletion leaves the account intact, its phones signed out')
  const X1 = await mkUser('Xan Refused')
  const X2 = await signInAgain(X1)
  const XS = await createSession(X1, 'Xan Refused')
  const refused = await executeAccountDelete(X1.id, { maxWipes: 0 }).then(() => 'deleted', (e: unknown) => e)
  check('fixture: the hosted empty moment makes the deletion refuse (409 class)', refused instanceof AccountDeleteTooManyWipesError, String(refused))
  check('the account survives', !!(await prisma.user.findUnique({ where: { id: X1.id } })))
  check('its moment survives', (await prisma.session.count({ where: { code: XS, deletedAt: null } })) === 1)
  check('🔒 its native sessions are ALREADY gone, both stores (so the app must sign out)', (await prisma.authSession.count({ where: { userId: X1.id } })) === 0 && (await redis.get(tokenOf(X1))) === null && (await redis.get(tokenOf(X2))) === null && !(await authenticates(X1)) && !(await authenticates(X2)))

  // ── § 9 the app's email change re-confirms the password ───────────────────
  // (A web caller still changes it without one: that branch is untouched.)
  section('§ 9 PATCH /api/me/account email from the app needs the current password')
  const E1 = await mkUser('Eve Email')
  const moved = `${TAG}-moved@example.test`
  const emailOf = async () => (await prisma.user.findUniqueOrThrow({ where: { id: E1.id }, select: { email: true } })).email
  await resetLimits()
  const emailNoPw = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { email: moved })
  check('🔒 no password → 400, the email stays', emailNoPw.status === 400 && emailNoPw.json?.error === 'current password required' && (await emailOf()) === E1.email, emailNoPw)
  const wrongPw = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { email: moved, currentPassword: 'wrong-password' })
  check('a wrong password → 400, the email stays', wrongPw.status === 400 && wrongPw.json?.error === 'current password incorrect' && (await emailOf()) === E1.email, wrongPw)
  const okPw = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { email: moved.toUpperCase(), currentPassword: E1.password })
  check('the right password → 200, the email moves (lower-cased)', okPw.status === 200 && (await emailOf()) === moved, okPw)
  const halfEmail = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { email: 'alice@', currentPassword: E1.password })
  check('🔒 an address Better Auth can\'t sign in with (alice@) → 400 from the app', halfEmail.status === 400 && halfEmail.json?.error === 'invalid email' && (await emailOf()) === moved, halfEmail)
  const nameOnly = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { name: 'Eve Renamed' })
  check('a name-only PATCH from the app still needs no password (the rule is email only)', nameOnly.status === 200 && (await prisma.user.findUniqueOrThrow({ where: { id: E1.id } })).name === 'Eve Renamed', nameOnly)
  const E2 = await mkUser('Eli Taken')
  const taken = await call(accountRoute.PATCH, 'PATCH', '/api/me/account', E1, { email: E2.email, currentPassword: E1.password })
  check('another account\'s email (right password) → 409, nothing moves', taken.status === 409 && (await emailOf()) === moved, taken)
  const signsIn = await betterAuthServer.api.signInEmail({ body: { email: moved, password: E1.password } }).then(() => true, () => false)
  const oldGone = await betterAuthServer.api.signInEmail({ body: { email: E1.email, password: E1.password } }).then(() => false, () => true)
  check('…the new email signs in, the old one no longer does', signsIn && oldGone)

  // ════════════════════════════════════════════════════════════════════════
  // Step 4: privacy that changes what others see
  // ════════════════════════════════════════════════════════════════════════

  // ── § 10 (a) canViewPosts, the pure table ─────────────────────────────────
  section('§ 10 canViewPosts: every check-in choice × profile tier × FoF × viewer')
  type Rel = 'anon' | 'stranger' | 'follower' | 'friend' | 'fof'
  const viewers: Record<Rel, { id: number | null; followsProfile: boolean; profileFollowsViewer: boolean; isFofOfProfile?: boolean }> = {
    anon: { id: null, followsProfile: false, profileFollowsViewer: false },
    stranger: { id: 2, followsProfile: false, profileFollowsViewer: false },
    follower: { id: 2, followsProfile: true, profileFollowsViewer: false },
    friend: { id: 2, followsProfile: true, profileFollowsViewer: true },
    fof: { id: 2, followsProfile: false, profileFollowsViewer: false, isFofOfProfile: true },
  }
  // The oracle, in audience terms (who is in each set), independent of the
  // edge-boolean implementation.
  const profileAdmits = (tier: string, fof: boolean, r: Rel) =>
    tier === 'public-internet' ? true
      : r === 'anon' ? false
      : tier === 'public-users' ? true
      : tier === 'public-followers' ? (r === 'follower' || r === 'friend' || (fof && r === 'fof'))
      : (r === 'friend' || (fof && r === 'fof'))
  const checkinAdmits = (c: string | null, r: Rel) =>
    c === null ? true
      : c === 'only-me' || r === 'anon' ? false
      : c === 'public-users' ? true
      : c === 'public-followers' ? (r === 'follower' || r === 'friend')
      : r === 'friend'
  const bad: string[] = []
  let cells = 0
  for (const visibility of ['public-internet', 'public-users', 'public-followers', 'public-mutual'] as const)
    for (const fofEnabled of [false, true])
      for (const checkinVisibility of [null, 'public-users', 'public-followers', 'public-mutual', 'only-me'] as const)
        for (const r of Object.keys(viewers) as Rel[]) {
          cells++
          const got = canViewPosts({ visibility, fofEnabled, checkinVisibility }, viewers[r])
          if (got !== (profileAdmits(visibility, fofEnabled, r) && checkinAdmits(checkinVisibility, r))) bad.push(`${visibility}/fof=${fofEnabled}/${checkinVisibility}/${r} → ${got}`)
        }
  check(`all ${cells} cells match the audience oracle`, bad.length === 0, bad)
  check('trap: Verre Users profile + stored FoF + check-ins Followers → a FoF-only viewer sees nothing',
    !canViewPosts({ visibility: 'public-users', fofEnabled: true, checkinVisibility: 'public-followers' }, viewers.fof))
  check('trap: Followers profile + check-ins Verre Users → the profile wins (a stranger sees nothing)',
    !canViewPosts({ visibility: 'public-followers', fofEnabled: false, checkinVisibility: 'public-users' }, viewers.stranger)
    && canViewPosts({ visibility: 'public-followers', fofEnabled: false, checkinVisibility: 'public-users' }, viewers.follower))
  check('FoF applies with Same as Profile only',
    canViewPosts({ visibility: 'public-mutual', fofEnabled: true, checkinVisibility: null }, viewers.fof)
    && !canViewPosts({ visibility: 'public-mutual', fofEnabled: true, checkinVisibility: 'public-mutual' }, viewers.fof))
  check('Only Me admits even a friend on an Everyone profile', !canViewPosts({ visibility: 'public-internet', fofEnabled: false, checkinVisibility: 'only-me' }, viewers.friend))

  // ── § 11 (b) the surfaces ─────────────────────────────────────────────────
  section('§ 11 every post surface: visible pair, hidden pair, self')
  const O = await mkUser('Olga Owner')
  const Rf = await mkUser('Rita Friend')
  const Fl = await mkUser('Finn Follower')
  const St = await mkUser('Sam Stranger')
  await prisma.follow.createMany({ data: [
    { followerId: Rf.id, followingId: O.id }, { followerId: O.id, followingId: Rf.id },
    { followerId: Fl.id, followingId: O.id },
  ] })
  type Vis = { profileVisibility?: string; visibilityFof?: boolean; checkinVisibility?: string | null; showCravings?: boolean; showMoments?: boolean; showLocations?: boolean }
  const setVis = (data: Vis) => prisma.user.update({ where: { id: O.id }, data })
  const VENUE = { venueName: 'Bar Olga', city: 'Basel', country: 'CH' }
  await resetLimits()
  const ci = await call(checkinsRoute.POST, 'POST', '/api/checkins', O, {
    wineName: `${TAG} Standalone`, score: 4, flavors: {}, imageData: PNG, ...VENUE, lat: 47.5, lng: 7.6,
    wineRegion: 'Douro', wineCountry: 'PT',
  })
  if (ci.status !== 201) throw new Error(`check-in POST ${ci.status} ${JSON.stringify(ci.json)}`)
  const postId = ci.json.id as number
  check('D12: the check-in photo key carries a random suffix', /^wines\/ci_\d+_\d+_[A-Za-z0-9_-]{12}\.png$/.test(keyOf(ci.json.imageUrl)), keyOf(ci.json.imageUrl))
  const OM = await createSession(O, 'Olga Owner')
  const ow = await addWine(OM, O, 'Moment Bottle')
  await rate(OM, O, ow.id)
  await bookmark(O.id, ow.id)
  await ensureBadgesSeedOnce()
  await prisma.userBadge.create({ data: { userId: O.id, badgeId: ALL_BADGES[0].id } })

  const feedOf = (v: User, user?: number) => call(feedRoute.GET, 'GET', user ? `/api/feed?user=${user}` : '/api/feed', v)
  const oItems = (f: { json: Record<string, any> }) => ((f.json?.items ?? []) as { author: { id: number } }[]).filter(i => i.author.id === O.id) // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  const oCheckin = (f: { json: Record<string, any> }) => (oItems(f) as unknown as { type: string; checkin?: Record<string, unknown> }[]).find(i => i.type === 'checkin')?.checkin // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  const webProfile = async (id: number, v: User | Actor) => { await resetLimits(); return call(usersRoute.GET, 'GET', `/api/users/${id}`, v, undefined, { id: String(id) }) }
  const like = async (v: User, method: 'POST' | 'DELETE') => { await resetLimits(); return call(method === 'POST' ? likeRoute.POST : likeRoute.DELETE, method, `/api/feed-items/${postId}/like`, v, undefined, { id: String(postId) }) }
  const sip = async (v: User) => { await resetLimits(); return call(checkinsRoute.POST, 'POST', '/api/checkins', v, { wineName: `${TAG} sip`, score: 3, flavors: {}, copyFromCheckinId: postId }) }

  // Baseline: Same as Profile on a Verre Users profile.
  check('baseline: the friend and the follower see both posts in the network feed', oItems(await feedOf(Rf)).length === 2 && oItems(await feedOf(Fl)).length === 2)
  check('baseline: ?user= shows the stranger both posts', oItems(await feedOf(St, O.id)).length === 2)
  let hdr = await getProfile(O.id, St)
  check('baseline: all three tiles, no checkinsAudience', Object.keys(hdr.tiles).sort().join() === 'cravings,impressions,moments' && !('checkinsAudience' in hdr), hdr.tiles)
  let wp = await webProfile(O.id, St)
  check('baseline: web payload has the posts + both counts', wp.json.recentCheckins.length === 1 && wp.json.recentSessionPosts.length === 1 && typeof wp.json.stats.checkins === 'number' && typeof wp.json.stats.sessions === 'number', wp.json.stats)
  check('Fl likes the post while it is visible', (await like(Fl, 'POST')).status === 200)

  // Friends only.
  await setVis({ checkinVisibility: 'public-mutual' })
  check('Friends: network feed — the friend still sees both posts', oItems(await feedOf(Rf)).length === 2)
  check('🔒 Friends: network feed — the follower sees none', oItems(await feedOf(Fl)).length === 0)
  check('Friends: network feed — self sees both', oItems(await feedOf(O)).length === 2)
  let uf = await feedOf(Fl, O.id)
  check('🔒 Friends: ?user= for the follower → 200 { items: [], nextCursor: null }', uf.status === 200 && uf.json.items.length === 0 && uf.json.nextCursor === null, uf)
  check('Friends: ?user= for the friend and self → both posts', oItems(await feedOf(Rf, O.id)).length === 2 && oItems(await feedOf(O, O.id)).length === 2)
  await patchProfile(O, { tiles: { impressions: ow.url } })
  hdr = await getProfile(O.id, Fl)
  check('🔒 Friends: header for the follower has NO impressions tile (count, photo, pin)', !('impressions' in hdr.tiles) && 'moments' in hdr.tiles && 'cravings' in hdr.tiles, hdr.tiles)
  check('Friends: …and checkinsAudience = public-mutual', hdr.checkinsAudience === 'public-mutual', hdr.checkinsAudience)
  check('…the stored impressions pin is kept', (await pins(O.id)).i === ow.url)
  hdr = await getProfile(O.id, Rf)
  check('Friends: header for the friend has all tiles (the pin served), no checkinsAudience', hdr.tiles.impressions?.imageUrl === ow.url && !('checkinsAudience' in hdr), hdr)
  const ownHdr = await getProfile(O.id, O)
  check('Friends: own header has every tile and never a checkinsAudience', Object.keys(ownHdr.tiles).length === 3 && !('checkinsAudience' in ownHdr))
  wp = await webProfile(O.id, Fl)
  check('🔒 Friends: web payload for the follower has no posts and no stats.checkins', wp.status === 200 && wp.json.recentCheckins.length === 0 && wp.json.recentSessionPosts.length === 0 && !('checkins' in wp.json.stats) && typeof wp.json.stats.sessions === 'number', wp.json.stats)
  wp = await webProfile(O.id, Rf)
  check('Friends: web payload for the friend keeps both', wp.json.recentCheckins.length === 1 && typeof wp.json.stats.checkins === 'number')
  check('🔒 like POST from the follower → 404', (await like(Fl, 'POST')).status === 404)
  check('like POST from the friend → 200', (await like(Rf, 'POST')).status === 200)
  const ul = await like(Fl, 'DELETE')
  check('D11: the follower can still take their OWN like off → 200 { liked: false }, no count', ul.status === 200 && ul.json.liked === false && !('count' in ul.json), ul)
  check('…and the row is gone', (await prisma.feedItemLike.count({ where: { userId: Fl.id, feedItemId: postId } })) === 0)
  check('D11: an unlike of a hidden post never liked → 404', (await like(Fl, 'DELETE')).status === 404)
  check('🔒 had a sip from the follower → 400 (the post gate)', (await sip(Fl)).status === 400)
  check('like POST on your own post (self) → 200', (await like(O, 'POST')).status === 200)

  // Followers: the follower is in again.
  await setVis({ checkinVisibility: 'public-followers' })
  check('Followers: the follower sees the posts again (network + ?user=)', oItems(await feedOf(Fl)).length === 2 && oItems(await feedOf(Fl, O.id)).length === 2)
  const sipOk = await sip(Fl)
  check('Followers: had a sip from the follower → 201', sipOk.status === 201, sipOk)
  uf = await feedOf(St, O.id)
  hdr = await getProfile(O.id, St)
  check('Followers: the stranger gets 200 empty + checkinsAudience public-followers', uf.json.items.length === 0 && hdr.checkinsAudience === 'public-followers')

  // Only Me.
  await setVis({ checkinVisibility: 'only-me' })
  hdr = await getProfile(O.id, Rf)
  check('Only Me: the friend sees no posts anywhere, checkinsAudience only-me', oItems(await feedOf(Rf)).length === 0 && oItems(await feedOf(Rf, O.id)).length === 0 && hdr.checkinsAudience === 'only-me' && !('impressions' in hdr.tiles))
  check('Only Me: like POST from the friend → 404', (await like(Rf, 'POST')).status === 404)
  check('Only Me: self still sees both', oItems(await feedOf(O)).length === 2 && oItems(await feedOf(O, O.id)).length === 2)

  // D11's 'gone' rule: a like that exists, then the author blocks the liker.
  await setVis({ checkinVisibility: null })
  const Gb = await mkUser('Gus Blocked')
  check('fixture: Gb likes the visible post', (await like(Gb, 'POST')).status === 200)
  await prisma.userBlock.create({ data: { blockerId: O.id, blockedId: Gb.id } })
  check('🔒 D11: author blocks you → unlike is 404 even though your like existed', (await like(Gb, 'DELETE')).status === 404)
  check('…and the like is still removed (an unblock must not bring it back)', (await prisma.feedItemLike.count({ where: { userId: Gb.id, feedItemId: postId } })) === 0)

  // Tighten the profile, then loosen it with RAW writes: a READ never clamps
  // a stored choice (the PATCH path collapses it, § 15).
  await setVis({ checkinVisibility: 'public-followers', profileVisibility: 'public-mutual' })
  check('tighten: the follower now gets the shell and a 404 on ?user=', (await webProfile(O.id, Fl)).json.gated === true && (await feedOf(Fl, O.id)).status === 404)
  check('…the stored check-in choice is untouched', (await prisma.user.findUniqueOrThrow({ where: { id: O.id } })).checkinVisibility === 'public-followers')
  await setVis({ profileVisibility: 'public-users' })
  check('loosen: the check-in choice comes back (the follower sees, the stranger does not)', oItems(await feedOf(Fl, O.id)).length === 2 && (await feedOf(St, O.id)).json.items.length === 0)
  await setVis({ checkinVisibility: null })

  // Show My Locations off: the VENUE goes, the wine's origin stays.
  await setVis({ showLocations: false })
  const placeless = (c: Record<string, unknown> | undefined) => !!c && c.venueName === null && c.city === null && c.country === null && c.wineRegion === 'Douro' && c.wineCountry === 'PT'
  const placed = (c: Record<string, unknown> | undefined) => !!c && c.venueName === VENUE.venueName && c.city === VENUE.city && c.country === VENUE.country
  check('🔒 Locations off: network feed — the friend sees no place, the wine origin stays', placeless(oCheckin(await feedOf(Rf))), oCheckin(await feedOf(Rf)))
  check('🔒 Locations off: ?user= — same', placeless(oCheckin(await feedOf(St, O.id))))
  wp = await webProfile(O.id, Rf)
  check('🔒 Locations off: web recentCheckins — no place', wp.json.recentCheckins[0]?.venueName === null && wp.json.recentCheckins[0]?.city === null && wp.json.recentCheckins[0]?.country === null, wp.json.recentCheckins[0])
  check('Locations off: the author still sees their own place (network, ?user=, web)', placed(oCheckin(await feedOf(O))) && placed(oCheckin(await feedOf(O, O.id))) && (await webProfile(O.id, O)).json.recentCheckins[0]?.venueName === VENUE.venueName)
  check('no feed or profile payload carries lat / lng', !/"lat"|"lng"/.test(JSON.stringify([(await feedOf(Rf)).json, (await feedOf(O, O.id)).json, (await webProfile(O.id, O)).json])))
  await setVis({ showLocations: true })
  check('Locations on: the friend sees the place', placed(oCheckin(await feedOf(Rf))))

  // Show Cravings / Show Moments off.
  await patchProfile(O, { tiles: { cravings: ow.url } })
  await setVis({ showCravings: false, showMoments: false })
  hdr = await getProfile(O.id, Rf)
  check('🔒 Cravings + Moments off: only the impressions tile for others', Object.keys(hdr.tiles).join() === 'impressions' && !('checkinsAudience' in hdr), hdr.tiles)
  check('…the stored cravings pin is kept', (await pins(O.id)).c === ow.url)
  wp = await webProfile(O.id, Rf)
  check('Moments off: web stats.sessions omitted (stats.checkins kept)', !('sessions' in wp.json.stats) && typeof wp.json.stats.checkins === 'number', wp.json.stats)
  check('Cravings + Moments off: own header keeps all three', Object.keys((await getProfile(O.id, O)).tiles).length === 3)
  await setVis({ showCravings: true, showMoments: true })

  // Badges: the earned date is owner-only.
  await resetLimits()
  const bOther = await call(badgesRoute.GET, 'GET', `/api/users/${O.id}/badges`, Rf, undefined, { id: String(O.id) })
  const bOwn = await call(badgesRoute.GET, 'GET', `/api/users/${O.id}/badges`, O, undefined, { id: String(O.id) })
  const first = (b: { json: Record<string, any> }) => b.json.badges.find((x: { id: string }) => x.id === ALL_BADGES[0].id) // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  check('🔒 badges: another viewer sees earned, never earned_at', first(bOther)?.earned === true && bOther.json.badges.every((x: { earned_at: unknown }) => x.earned_at === null), first(bOther))
  check('badges: the owner sees the date', first(bOwn)?.earned === true && first(bOwn)?.earned_at !== null)

  // D13: the check-in PATCH / DELETE answer a non-owner like a missing id.
  await resetLimits()
  const foreignPatch = await call((await import('../../app/api/checkins/[id]/route.ts')).PATCH, 'PATCH', `/api/checkins/${postId}`, Rf, { notes: 'mine now' }, { id: String(postId) })
  const foreignDel = await call((await import('../../app/api/checkins/[id]/route.ts')).DELETE, 'DELETE', `/api/checkins/${postId}`, Rf, undefined, { id: String(postId) })
  check('D13: a non-owner PATCH / DELETE of a check-in → 404 (not 403)', foreignPatch.status === 404 && foreignDel.status === 404, [foreignPatch.status, foreignDel.status])

  // ── § 12 (c2) no moment code in a non-participant's payloads ──────────────
  section('§ 12 no profile / feed payload a non-participant receives carries a moment code')
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${urlOf(`sessions/${OM}_${Date.now()}`)} WHERE code = ${OM}`
  const seen = JSON.stringify([(await feedOf(Rf)).json, (await feedOf(Rf, O.id)).json, await getProfile(O.id, Rf), (await webProfile(O.id, Rf)).json, (await webProfile(O.id, {})).json])
  check(`the friend's feed / ?user= / header / web payloads never contain ${OM}`, !seen.includes(OM) && seen.includes('Moment Bottle'))

  // ── § 13 (c) compare-and-set ──────────────────────────────────────────────
  section('§ 13 PATCH /api/me/visibility compare-and-set')
  const C = await mkUser('Cora CAS')
  const getVis = async () => { const r = await call(visibilityRoute.GET, 'GET', '/api/me/visibility', C); return r }
  const patchVis = (body: unknown) => call(visibilityRoute.PATCH, 'PATCH', '/api/me/visibility', C, body)
  await resetLimits()
  let g0 = await getVis()
  const snap0 = g0.json
  const defaults: Record<string, unknown> = { visibility: 'public-users', fofEnabled: false, checkinVisibility: null, showCravings: true, showMoments: true, showLocations: true }
  check('GET → the six fields (defaults)', g0.status === 200 && Object.keys(snap0).length === 6 && Object.entries(defaults).every(([k, v]) => snap0[k] === v), snap0)
  const rawGet = await visibilityRoute.GET(new NextRequest(`${BASE}/api/me/visibility`, { headers: { cookie: C.cookie } }))
  check('GET carries Cache-Control: private, no-store', rawGet.headers.get('cache-control') === 'private, no-store')
  const legacy = await patchVis({ visibility: 'public-followers', fofEnabled: false })
  check('the legacy shape (no expected) → 400 with readable copy', legacy.status === 400 && legacy.json.error === 'Reload the page and try again.', legacy)
  check('expected missing a field → 400', (await patchVis({ expected: { ...snap0, showLocations: undefined }, showCravings: false })).status === 400)
  check('an unknown change key → 400', (await patchVis({ expected: snap0, bogus: 1 })).status === 400)
  check('an ill-typed change → 400', (await patchVis({ expected: snap0, showCravings: 'no' })).status === 400 && (await patchVis({ expected: snap0, checkinVisibility: 'public-internet' })).status === 400)
  check('no change at all → 400', (await patchVis({ expected: snap0 })).status === 400)
  const counter = async () => Number((await redis.get(`rl:visibility:u:${C.id}:1h`)) ?? 0)
  await resetLimits()
  let pr = await patchVis({ expected: snap0, checkinVisibility: 'only-me' })
  check('a change → 200 { ok, current }, the rest untouched', pr.status === 200 && pr.json.ok === true && pr.json.current.checkinVisibility === 'only-me' && pr.json.current.visibility === 'public-users' && pr.json.current.showCravings === true, pr)
  const retry = await patchVis({ expected: snap0, checkinVisibility: 'only-me' })
  check('a retry whose first attempt committed (stale expected, same target) → 200 no-op', retry.status === 200 && retry.json.current.checkinVisibility === 'only-me', retry)
  check('…charged once (the no-op charges nothing)', (await counter()) === 1, await counter())
  const rawPatch = await visibilityRoute.PATCH(new NextRequest(`${BASE}/api/me/visibility`, { method: 'PATCH', headers: { cookie: C.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expected: pr.json.current, showMoments: false }) }))
  check('PATCH carries Cache-Control: private, no-store', rawPatch.headers.get('cache-control') === 'private, no-store' && rawPatch.status === 200)
  check('two changes charged the 30/h counter twice', (await counter()) === 2, await counter())
  const stale = await patchVis({ expected: snap0, showCravings: false })
  check('🔒 a stale expected → 409 { error, current }', stale.status === 409 && typeof stale.json.error === 'string' && stale.json.current?.checkinVisibility === 'only-me' && stale.json.current?.showMoments === false, stale)
  check('the 409 changed nothing', (await prisma.user.findUniqueOrThrow({ where: { id: C.id } })).showCravings === true)
  check('the 409 charged nothing', (await counter()) === 2, await counter())
  const back = await patchVis({ expected: stale.json.current, checkinVisibility: null, showMoments: true })
  check('several changes in one PATCH, Same as Profile back as null', back.status === 200 && back.json.current.checkinVisibility === null && back.json.current.showMoments === true, back)
  const log = await prisma.profileVisibilityLog.findMany({ where: { userId: C.id }, orderBy: { id: 'asc' } })
  const lastLog = log[log.length - 1]
  check('audit: one row per change (3), each a full snapshot', log.length === 3 && log.every(l => l.toTier && l.toCheckinTier !== null && l.toShowCravings !== null && l.toShowMoments !== null && l.toShowLocations !== null && l.fromCheckinTier !== null), log)
  check('audit: Same as Profile logged as the sentinel "profile"', log[0].fromCheckinTier === 'profile' && log[0].toCheckinTier === 'only-me' && lastLog.toCheckinTier === 'profile' && lastLog.fromShowMoments === false && lastLog.toShowMoments === true, { first: log[0], lastLog })
  // A corrupt stored value reads as only-me for the owner too, so a save
  // against what the GET showed still lands (never a permanent 409).
  await prisma.$executeRawUnsafe('ALTER TABLE users DROP CONSTRAINT checkin_visibility_chk')
  try {
    await prisma.$executeRaw`UPDATE users SET checkin_visibility = 'bogus' WHERE id = ${C.id}`
    g0 = await getVis()
    const corruptGate = await getProfile(C.id, O)
    check('fail closed: a corrupt stored value reads as only-me (owner GET + the gate)', g0.json.checkinVisibility === 'only-me' && corruptGate.checkinsAudience === 'only-me' && !('impressions' in corruptGate.tiles), { g: g0.json, a: corruptGate.checkinsAudience })
    pr = await patchVis({ expected: g0.json, checkinVisibility: null })
  } finally {
    await prisma.$executeRaw`UPDATE users SET checkin_visibility = NULL WHERE checkin_visibility = 'bogus'`
    await prisma.$executeRawUnsafe(`ALTER TABLE users ADD CONSTRAINT checkin_visibility_chk CHECK ("checkin_visibility" IS NULL OR "checkin_visibility" IN ('public-users','public-followers','public-mutual','only-me'))`)
  }
  check('…and the owner can overwrite it', pr.status === 200 && pr.json.current.checkinVisibility === null, pr)

  // The LOCK: a holder keeps the row FOR UPDATE; two PATCHes with the same
  // snapshot and different changes both wait; after COMMIT exactly one wins.
  await resetLimits()
  const snap1 = (await getVis()).json
  const { Client: PgClient } = await import('pg')
  const rowHolder = new PgClient({ connectionString: DB })
  await rowHolder.connect()
  await rowHolder.query('BEGIN')
  await rowHolder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [C.id])
  const pA = patchVis({ expected: snap1, showCravings: false })
  const pB = patchVis({ expected: snap1, showMoments: false })
  check('🔒 both PATCHes block on the users-row lock', await lockWaiters(2, [pA, pB]))
  await rowHolder.query('COMMIT')
  await rowHolder.end()
  const [rA, rB] = await Promise.all([pA, pB])
  const statuses = [rA.status, rB.status].sort().join()
  const finalRow = await prisma.user.findUniqueOrThrow({ where: { id: C.id } })
  check('🔒 …then exactly one 200 and one 409', statuses === '200,409', [rA, rB])
  check('…and only the winner\'s change is stored', (finalRow.showCravings === false) !== (finalRow.showMoments === false), finalRow)

  // ── § 14 (d) the CHECK ────────────────────────────────────────────────────
  section('§ 14 the checkin_visibility CHECK')
  const rejects = async (v: string) => prisma.$executeRaw`UPDATE users SET checkin_visibility = ${v} WHERE id = ${C.id}`.then(() => false, () => true)
  check("a raw write of 'public-internet' is rejected", await rejects('public-internet'))
  check('a raw write of a bogus value is rejected', await rejects('everyone'))
  check('every union member is accepted', (await Promise.all(['public-users', 'public-followers', 'public-mutual', 'only-me'].map(rejects))).every(x => !x))

  // ── § 15 the extended circle follows the tier + the shared rule ───────────
  section('§ 15 the extended circle follows the tier; Same as Account is canonical')
  // (a) The shared rule against the server's predicate, every state × viewer.
  type Tier = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual'
  type Posts = null | 'public-users' | 'public-followers' | 'public-mutual' | 'only-me'
  type AState = { visibility: Tier; fofEnabled: boolean; checkinVisibility: Posts; showCravings: boolean; showMoments: boolean; showLocations: boolean }
  const TIERS: Tier[] = ['public-internet', 'public-users', 'public-followers', 'public-mutual']
  const POSTS: Posts[] = [null, 'public-users', 'public-followers', 'public-mutual', 'only-me']
  const rels: { id: number | null; followsProfile: boolean; profileFollowsViewer: boolean; isFofOfProfile: boolean }[] = [{ id: null, followsProfile: false, profileFollowsViewer: false, isFofOfProfile: false }]
  for (const f of [false, true]) for (const b of [false, true]) for (const x of [false, true]) rels.push({ id: 2, followsProfile: f, profileFollowsViewer: b, isFofOfProfile: x })
  const aud = (s: AState) => rels.map(r => canViewPosts(s, r))
  const same = (a: boolean[], b: boolean[]) => a.every((x, i) => x === b[i])
  const within = (a: boolean[], b: boolean[]) => a.every((x, i) => !x || b[i])
  const states: AState[] = TIERS.flatMap(visibility => [false, true].flatMap(fofEnabled => POSTS.map(checkinVisibility => ({ visibility, fofEnabled, checkinVisibility, showCravings: true, showMoments: true, showLocations: true }))))
  const CHANGES: Partial<AState>[] = [
    ...TIERS.map(visibility => ({ visibility })), { fofEnabled: true }, { fofEnabled: false },
    ...POSTS.map(checkinVisibility => ({ checkinVisibility })), { showCravings: false },
  ]
  const ruleBad: string[] = []
  for (const s of states) {
    if (!same(aud(canonicalPostAudience(s)), aud(s))) ruleBad.push(`collapse changed ${JSON.stringify(s)}`)
    for (const ch of CHANGES) {
      const next = applyVisibilityChanges(s, ch), plain = { ...canonicalPostAudience(s), ...ch }
      const ok = 'visibility' in ch || 'fofEnabled' in ch ? within(aud(next), aud(plain)) : same(aud(next), aud(plain))
      if (!ok) ruleBad.push(`${JSON.stringify(ch)} on ${JSON.stringify(s)} → ${JSON.stringify(next)}`)
    }
  }
  check(`the shared rule: ${states.length} states × ${rels.length} viewers × ${CHANGES.length} changes, never wider, exact where it must be`, ruleBad.length === 0, ruleBad.slice(0, 5))
  const BR: Record<string, number> = { 'public-internet': 0, 'public-users': 1, 'public-followers': 2, 'public-mutual': 3, 'only-me': 4 }
  const round1 = (s: AState): AState => s.checkinVisibility && s.checkinVisibility !== 'only-me' && BR[s.checkinVisibility] < BR[s.visibility] ? { ...s, checkinVisibility: null } : s
  check('negative control: the round-1 rule (collapse anything broader) WIDENS somewhere, so the oracle can see it', states.some(s => !within(aud(round1(s)), aud(s))))
  const trap: AState = { visibility: 'public-mutual', fofEnabled: true, checkinVisibility: 'public-followers', showCravings: true, showMoments: true, showLocations: true }
  const fofNonFollower = rels.find(r => r.id !== null && !r.followsProfile && !r.profileFollowsViewer && r.isFofOfProfile)!
  check('🔒 trap: Friends + circle + posts Followers stays Followers (on read and on an unrelated save)',
    canonicalPostAudience(trap).checkinVisibility === 'public-followers' && applyVisibilityChanges(trap, { showCravings: false }).checkinVisibility === 'public-followers')
  check('🔒 trap: …so a friend of a friend who doesn\'t follow stays out of the posts (Same as Account would let them in)',
    !canViewPosts(canonicalPostAudience(trap), fofNonFollower) && canViewPosts({ ...trap, checkinVisibility: null }, fofNonFollower))
  const offOn = applyVisibilityChanges(applyVisibilityChanges({ ...trap, checkinVisibility: 'public-mutual' }, { fofEnabled: false }), { fofEnabled: true })
  check('ruled 2026-11-11: posts Friends (without the circle), circle off then on → Same as Account, for good', offOn.checkinVisibility === null, offOn)

  // (b) The real queries. One graph: four negatives each missing exactly ONE
  // edge of viewer↔X↔owner (a1 viewer→X, a2 X→viewer, b1 X→owner, b2
  // owner→X: V5, V3, V6, V4), plus V2, a one-way follower of a follower.
  const OWNER_NAME = `Ottilie ${TAG}` // unique per run: search lists the first 10 by name
  const Ow = await mkUser(OWNER_NAME)
  const [Xf, Yf, Zf] = [await mkUser('Xaver Friend'), await mkUser('Yara Follower'), await mkUser('Zeno Followed')]
  const circle: User[] = []
  for (const n of ['Vera Fof', 'Vince Chain', 'Vito NoA2', 'Vala NoB2', 'Vreni NoA1', 'Vik NoB1']) circle.push(await mkUser(n))
  const [V1, V2, V3, V4, V5, V6] = circle
  const e = (a: User, b: User) => ({ followerId: a.id, followingId: b.id })
  await prisma.follow.createMany({ data: [
    e(Xf, Ow), e(Ow, Xf),            // X ↔ owner (a friend)
    e(Yf, Ow),                       // Y → owner (a follower only)
    e(Ow, Zf), e(Zf, V6), e(V6, Zf), // owner → Z only; Z ↔ V6
    e(V1, Xf), e(Xf, V1),            // V1 ↔ X: a friend of a friend
    e(V2, Yf),                       // V2 → Y → owner: a follower of a follower
    e(V3, Xf),                       // V3 → X, not back (no a2)
    e(V4, Yf), e(Yf, V4),            // V4 ↔ Y, owner doesn't follow Y (no b2)
    e(Xf, V5),                       // X → V5, not back (no a1)
  ] })
  const setOw = (data: Vis) => prisma.user.update({ where: { id: Ow.id }, data })
  const singleSees = async (v: User) => (await webProfile(Ow.id, v)).json.gated !== true
  const bulkSees = async (v: User) => {
    await resetLimits()
    const r = await call(searchRoute.GET, 'GET', `/api/users/search?q=${encodeURIComponent(OWNER_NAME)}`, v)
    const hit = (r.json as unknown as { id: number; gated?: boolean }[]).find(x => x.id === Ow.id)
    if (!hit) throw new Error(`search did not list the owner for ${v.id}`)
    return hit.gated !== true
  }
  // Who is admitted, by the single gate and by the bulk set, separately.
  const admitted = async () => {
    const single: string[] = [], bulk: string[] = []
    for (const [i, v] of circle.entries()) {
      if (await singleSees(v)) single.push(`V${i + 1}`)
      if (await bulkSees(v)) bulk.push(`V${i + 1}`)
    }
    return { single: single.join(), bulk: bulk.join() }
  }
  const both = (g: { single: string; bulk: string }, want: string) => g.single === want && g.bulk === want
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: true })
  let got = await admitted()
  check('🔒 Friends + Friends of Friends: only the friend of a friend (single + bulk); not V2 (follower of a follower), V3 (follows the friend, not back), V4 (friend of a mere follower), V5, V6', both(got, 'V1'), got)
  await setOw({ profileVisibility: 'public-followers', visibilityFof: true })
  got = await admitted()
  check('Followers + Followers of Followers: anyone following someone who follows the owner (V1–V4; not V5, V6)', both(got, 'V1,V2,V3,V4'), got)
  await setOw({ visibilityFof: false })
  got = await admitted()
  check('Followers, switch off: none', both(got, ''), got)
  await setOw({ profileVisibility: 'public-mutual' })
  got = await admitted()
  check('Friends, switch off: none', both(got, ''), got)

  // A block either way between the person in the middle and either end breaks
  // the link (ruled 2026-11-11); the follow rows stay.
  const v1Sees = async () => ({ single: await singleSees(V1), bulk: await bulkSees(V1) })
  const blockedOut = async (blocker: User, blocked: User) => {
    await prisma.userBlock.create({ data: { blockerId: blocker.id, blockedId: blocked.id } })
    try { return await v1Sees() } finally { await prisma.userBlock.deleteMany({ where: { blockerId: blocker.id, blockedId: blocked.id } }) }
  }
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: true })
  for (const [label, a, b] of [['the owner blocks X', Ow, Xf], ['X blocks the owner', Xf, Ow], ['X blocks the viewer', Xf, V1], ['the viewer blocks X', V1, Xf]] as const) {
    const r = await blockedOut(a, b)
    check(`🔒 Friends of Friends: ${label} → the friend of a friend is out (single + bulk)`, !r.single && !r.bulk, r)
  }
  const unblocked = await v1Sees()
  check('…and with no block they are in again', unblocked.single && unblocked.bulk, unblocked)
  await setOw({ profileVisibility: 'public-followers' })
  for (const [label, a, b] of [['the owner blocks X', Ow, Xf], ['X blocks the owner', Xf, Ow], ['X blocks the viewer', Xf, V1], ['the viewer blocks X', V1, Xf]] as const) {
    const r = await blockedOut(a, b)
    check(`🔒 Followers of Followers: ${label} → out (single + bulk)`, !r.single && !r.bulk, r)
  }
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: false })

  // The network feed (bulk, the posts gate): viewers who follow the owner
  // one-way, so the owner is in their network and only the circle can admit.
  const [W1, W3] = [await mkUser('Walt Fof'), await mkUser('Wim NoA2')]
  await prisma.follow.createMany({ data: [e(W1, Ow), e(W1, Xf), e(Xf, W1), e(W3, Ow), e(W3, Xf)] })
  await resetLimits()
  const owPost = await call(checkinsRoute.POST, 'POST', '/api/checkins', Ow, { wineName: `${TAG} circle`, score: 4, flavors: {} })
  if (owPost.status !== 201) throw new Error(`owner check-in ${owPost.status}`)
  const owIn = async (v: User) => ((await feedOf(v)).json.items as { author: { id: number } }[]).some(i => i.author.id === Ow.id)
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: true })
  check('🔒 network feed, Friends of Friends: the friend of a friend sees the post, a follower of the friend (not followed back) does not', (await owIn(W1)) && !(await owIn(W3)))
  await setOw({ visibilityFof: false })
  check('network feed, switch off: neither', !(await owIn(W1)) && !(await owIn(W3)))

  // (c) The server's write applies the shared rule; a READ only collapses.
  const owVis = async () => { await resetLimits(); return (await call(visibilityRoute.GET, 'GET', '/api/me/visibility', Ow)).json as unknown as AState }
  const owPatch = async (changes: Partial<AState>) => { const expected = await owVis(); await resetLimits(); return call(visibilityRoute.PATCH, 'PATCH', '/api/me/visibility', Ow, { expected, ...changes }) }
  const storedPosts = async () => (await prisma.user.findUniqueOrThrow({ where: { id: Ow.id } })).checkinVisibility
  await setOw({ profileVisibility: 'public-users', visibilityFof: false, checkinVisibility: 'public-followers' })
  let w = await owPatch({ visibility: 'public-mutual' })
  check('narrowing the account past the posts choice turns Same as Account back on (stored NULL)', w.status === 200 && w.json.current.checkinVisibility === null && (await storedPosts()) === null, w.json)
  w = await owPatch({ visibility: 'public-users' })
  check('…and loosening it again keeps Same as Account (the old choice doesn\'t come back)', w.json.current.checkinVisibility === null && (await storedPosts()) === null)
  await setOw({ profileVisibility: 'public-followers', visibilityFof: true, checkinVisibility: 'public-followers' })
  w = await owPatch({ visibility: 'public-mutual' })
  check('🔒 clamp: Followers + circle + posts Followers → account Friends: posts become Friends (only narrows)', w.json.current.checkinVisibility === 'public-mutual' && (await storedPosts()) === 'public-mutual', w.json)
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: true, checkinVisibility: 'public-followers' })
  const auditBefore = await prisma.profileVisibilityLog.count({ where: { userId: Ow.id } })
  check('🔒 a READ never clamps: the owner\'s GET keeps Friends + circle + posts Followers', (await owVis()).checkinVisibility === 'public-followers')
  const v1Posts = await feedOf(V1, Ow.id)
  check('🔒 …the gate: a friend of a friend who doesn\'t follow sees the profile, not the posts (?user= → 200 empty)',
    (await singleSees(V1)) && v1Posts.status === 200 && v1Posts.json.items.length === 0, v1Posts.json)
  const w1Posts = await feedOf(W1, Ow.id)
  check('…one who also follows sees them (?user= and the network feed), and so does the friend', w1Posts.json.items.length > 0 && (await owIn(W1)) && (await owIn(Xf)), w1Posts.json)
  w = await owPatch({ visibility: 'public-mutual', fofEnabled: true })
  check('the same tier + circle sent again (the web sends both) is a no-op: no clamp, no audit row', w.status === 200 && w.json.current.checkinVisibility === 'public-followers' && (await prisma.profileVisibilityLog.count({ where: { userId: Ow.id } })) === auditBefore, w.json)
  w = await owPatch({ showCravings: false })
  check('an unrelated change (Show Cravings) never touches the posts choice', w.json.current.checkinVisibility === 'public-followers' && (await storedPosts()) === 'public-followers', w.json)
  await setOw({ profileVisibility: 'public-mutual', visibilityFof: false, checkinVisibility: 'public-users', showCravings: true })
  check('a READ applies the exact collapse: a stored choice equal to the account reads as Same as Account (the row is untouched)', (await owVis()).checkinVisibility === null && (await storedPosts()) === 'public-users')
  w = await owPatch({ showMoments: false })
  check('…and the next save stores it canonically', w.json.current.checkinVisibility === null && (await storedPosts()) === null, w.json)
  const lastAudit = await prisma.profileVisibilityLog.findFirst({ where: { userId: Ow.id }, orderBy: { id: 'desc' } })
  check('…the audit logs what the row held (public-users), not its collapsed reading', lastAudit?.fromCheckinTier === 'public-users' && lastAudit?.toCheckinTier === 'profile', lastAudit)

  // ── § 16 People + Add Friends ─────────────────────────────────────────────
  section('§ 16 people lists, in common, search, tasted-with, the shell')
  const PS = `${TAG}-p`
  let bare = 0
  const mkBare = async (name: string, data: Vis & { xp?: number; imageUrl?: string } = {}) =>
    (await prisma.user.create({ data: { name, email: `${PS}-${++bare}@example.test`, ...data }, select: { id: true } })).id
  const mutual = (a: number, b: number) => [{ followerId: a, followingId: b }, { followerId: b, followingId: a }]
  const follow = (a: number, b: number) => ({ followerId: a, followingId: b })
  type Row = { id: number; name: string; xp: number | null; imageUrl: string | null; isFollowing: boolean; followsViewer: boolean; momentsTogether: number | null; friendsInCommon: number | null }
  const list = async (v: User, id: number, dir: 'followers' | 'following', qs = '') => {
    await resetLimits()
    const r = await call(dir === 'followers' ? followersRoute.GET : followingRoute.GET, 'GET', `/api/users/${id}/${dir}${qs}`, v, undefined, { id: String(id) })
    return r as { status: number; json: { users: Row[]; nextCursor: string | null; knownCount?: number } }
  }
  const idsOf = (rows: { id: number }[]) => rows.map(r => r.id).sort((a, b) => a - b).join()
  const want = (...xs: number[]) => [...xs].sort((a, b) => a - b).join()

  const Vic = await mkUser(`Vic ${PS}`)
  await prisma.user.update({ where: { id: Vic.id }, data: { imageUrl: 'https://img.test/vic.jpg', xp: 7 } })
  const Ola = await mkBare(`Ola ${PS}`)
  const F1 = await mkBare(`Fia ${PS}`, { profileVisibility: 'public-internet', imageUrl: 'https://img.test/f1.jpg', xp: 11 })
  const F2 = await mkBare(`Fred ${PS}`, { profileVisibility: 'public-mutual', imageUrl: 'https://img.test/f2.jpg', xp: 22 })
  const F3 = await mkBare(`Finn ${PS}`, { imageUrl: 'https://img.test/f3.jpg' })
  const F4 = await mkBare(`Flo ${PS}`, { imageUrl: 'https://img.test/f4.jpg' })
  const F5 = await mkBare(`Fynn ${PS}`, { profileVisibility: 'public-mutual', visibilityFof: true, imageUrl: 'https://img.test/f5.jpg', xp: 55 })
  await prisma.follow.createMany({ data: [
    ...mutual(Ola, F1), ...mutual(Ola, F2), ...mutual(Ola, F3), ...mutual(Ola, F4), ...mutual(Ola, F5), ...mutual(Ola, Vic.id),
    follow(Vic.id, F1), follow(Vic.id, F2), follow(Vic.id, F3), follow(Vic.id, F4),
    ...mutual(F1, F2), ...mutual(F1, F3),
    follow(F1, Vic.id),
  ] })
  // Block pairs with the VIEWER, both directions: F3 blocks Vic, Vic blocks F4.
  await prisma.userBlock.createMany({ data: [{ blockerId: F3, blockedId: Vic.id }, { blockerId: Vic.id, blockedId: F4 }] })

  const friends = await list(Vic, Ola, 'followers', '?mutual=mutual')
  const byId = new Map(friends.json.users.map(r => [r.id, r]))
  check('🔒 Ola\'s Friends as Vic: no row for a block pair with the viewer, either way (F3 blocked Vic, Vic blocked F4)', friends.status === 200 && idsOf(friends.json.users) === want(F1, F2, F5, Vic.id), friends.json)
  const olaHeader = await getProfile(Ola, Vic)
  check('…the tab count stays global (the header counts both; rows can be fewer, block.md)', olaHeader.friendsCount === 6, olaHeader.friendsCount)
  check('🔒 knownCount uses the rows\' block rule: 2 (F1, F2), never the blocked F3 / F4', friends.json.knownCount === 2, friends.json.knownCount)
  check('🔒 header inCommon.count == the Friends knownCount, faces only from those rows', olaHeader.inCommon?.count === 2 && idsOf(olaHeader.inCommon.faces) === want(F1, F2), olaHeader.inCommon)
  const faces = new Map((olaHeader.inCommon?.faces ?? []).map((f: { id: number; imageUrl: string | null }) => [f.id, f.imageUrl]))
  check('🔒 each face\'s photo follows that person\'s tier (F2 is Friends-only: null), photo faces first', faces.get(F1) === 'https://img.test/f1.jpg' && faces.get(F2) === null && olaHeader.inCommon.faces[0].id === F1, olaHeader.inCommon.faces)
  const known = await list(Vic, Ola, 'followers', '?mutual=mutual&known=1')
  check('?known=1: only people Vic follows, as many rows as knownCount', idsOf(known.json.users) === want(F1, F2) && known.json.knownCount === 2, known.json)
  const knownQ = await list(Vic, Ola, 'followers', `?mutual=mutual&known=1&q=${encodeURIComponent('Fia')}`)
  check('?known=1 composes with q (and a q page carries no knownCount)', idsOf(knownQ.json.users) === want(F1) && knownQ.json.knownCount === undefined, knownQ.json)
  const f1 = byId.get(F1)!, f2 = byId.get(F2)!, f5 = byId.get(F5)!, me = byId.get(Vic.id)!
  check('Everyone-tier row: photo + xp shown', f1.imageUrl === 'https://img.test/f1.jpg' && f1.xp === 11)
  check('🔒 a Friends-only person Vic only follows one way: photo, xp and friends in common are null', f2.imageUrl === null && f2.xp === null && f2.friendsInCommon === null, f2)
  check('🔒 Friends + Friends of Friends, Vic a friend of their friend (Ola): admitted, photo + xp', f5.imageUrl === 'https://img.test/f5.jpg' && f5.xp === 55, f5)
  const direct = await viewableProfiles(Vic.id, [F3, F4, F1, Vic.id])
  check('🔒 viewableProfiles on its own: a block pair either way is denied before the tier (F3, F4 are Verre Users); self + F1 admitted', idsOf([...direct.admitted].map(id => ({ id }))) === want(F1, Vic.id), [...direct.admitted])
  check('your own row: your photo + xp, no lines (momentsTogether / friendsInCommon null)', me.imageUrl === 'https://img.test/vic.jpg' && me.xp === 7 && me.momentsTogether === null && me.friendsInCommon === null, me)
  check('followsViewer + isFollowing per row (F1 follows Vic, F2 doesn\'t; Vic follows both, not F5)', f1.followsViewer && !f2.followsViewer && f1.isFollowing && f2.isFollowing && !f5.isFollowing)
  check('🔒 friendsInCommon for F1 = Ola + F2 (F3, who blocked Vic, is not counted)', f1.friendsInCommon === 2, f1.friendsInCommon)
  const f1Friends = await list(Vic, F1, 'followers', '?mutual=mutual&known=1')
  check('🔒 …and F1\'s own known Friends list has exactly those rows (a count never exceeds its rows)', idsOf(f1Friends.json.users) === want(Ola, F2), f1Friends.json)
  check('…the same number as F1\'s header in common', (await getProfile(F1, Vic)).inCommon?.count === 2)
  const ownList = await list(Vic, Vic.id, 'following')
  check('your own list: no knownCount, ?known ignored', ownList.json.knownCount === undefined && idsOf((await list(Vic, Vic.id, 'following', '?known=1')).json.users) === idsOf(ownList.json.users))
  check('your own Following hides the person you blocked (F4) and the one who blocked you (F3)', idsOf(ownList.json.users) === want(Ola, F1, F2), ownList.json)

  // Cursor + known: 31 followers of Ola that Vic follows, 3 he doesn't.
  const crowd: number[] = []
  for (let i = 0; i < 34; i++) crowd.push(await mkBare(`Crowd ${i} ${PS}`))
  await prisma.follow.createMany({ data: [...crowd.map(c => follow(c, Ola)), ...crowd.slice(0, 31).map(c => follow(Vic.id, c))] })
  const k1 = await list(Vic, Ola, 'followers', '?known=1')
  const k2 = await list(Vic, Ola, 'followers', `?known=1&cursor=${k1.json.nextCursor}`)
  const known34 = [...crowd.slice(0, 31), F1, F2]
  check('?known=1 pages with the cursor: 30 + the rest, no repeats, only known people', k1.json.users.length === 30 && k1.json.nextCursor !== null && idsOf([...k1.json.users, ...k2.json.users]) === want(...known34) && k2.json.nextCursor === null && k2.json.knownCount === undefined, { n1: k1.json.users.length, n2: k2.json.users.length })
  check('…the first page\'s knownCount covers every page', k1.json.knownCount === known34.length, k1.json.knownCount)

  // The together predicate.
  const past = new Date(Date.now() - 86400_000), future = new Date(Date.now() + 86400_000)
  let mseq = 0
  const moment = async (members: number[], o: { dateFrom?: Date | null; name?: string | null; createdAt?: Date; deleted?: boolean; kicked?: number[] } = {}) => {
    const code = `PS${TAG.slice(-6)}${++mseq}`.toUpperCase().slice(0, 16)
    const [{ id }] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO sessions (code, name, created_at, date_from, deleted_at)
      VALUES (${code}, ${o.name === undefined ? `Moment ${mseq}` : o.name}, ${o.createdAt ?? past}, ${o.dateFrom === undefined ? past : o.dateFrom}, ${o.deleted ? new Date() : null})
      RETURNING id`
    await prisma.sessionMember.createMany({ data: members.map(u => ({ userId: u, sessionCode: code, removedState: o.kicked?.includes(u) ? 'kicked' : null })) })
    return id
  }
  await moment([Vic.id, F1])                                  // started: counts
  await moment([Vic.id, F1], { dateFrom: null })              // dateless: counts
  await moment([Vic.id, F1], { dateFrom: future })            // upcoming: no
  await moment([Vic.id, F1], { kicked: [Vic.id] })            // viewer kicked: no
  await moment([Vic.id, F1], { kicked: [F1] })                // they were kicked: no
  await moment([Vic.id, F1], { deleted: true })               // deleted row (synthetic: code + members kept): no
  const f1Again = (await list(Vic, Ola, 'followers', '?mutual=mutual')).json.users.find(r => r.id === F1)!
  check('🔒 momentsTogether: started + dateless count; upcoming, kicked (either side) and deleted don\'t', f1Again.momentsTogether === 2, f1Again.momentsTogether)

  // Tasted with: six excluded people share the NEWEST moment, so a filter
  // applied after the limit would drop T2.
  // Tim is created before Toni, so an id tie-break alone would put Toni first.
  const T1 = await mkBare(`Tess ${PS}`, { imageUrl: 'https://img.test/t1.jpg', profileVisibility: 'public-internet' })
  const T3 = await mkBare(`Tim ${PS}`, { profileVisibility: 'public-mutual', imageUrl: 'https://img.test/t3.jpg' })
  const T2 = await mkBare(`Toni ${PS}`)
  const X = [] as number[]
  for (let i = 0; i < 6; i++) X.push(await mkBare(`Excluded ${i} ${PS}`))
  await prisma.follow.createMany({ data: [follow(Vic.id, X[0]), follow(Vic.id, X[1]), follow(T2, Vic.id)] })
  await prisma.userMute.createMany({ data: [{ muterId: Vic.id, mutedId: X[2] }, { muterId: Vic.id, mutedId: X[3] }] })
  await prisma.userBlock.createMany({ data: [{ blockerId: X[4], blockedId: Vic.id }, { blockerId: Vic.id, blockedId: X[5] }] })
  const t = (h: number) => new Date(Date.now() - h * 3600_000)
  await moment([Vic.id, ...X], { dateFrom: t(1) })
  await moment([Vic.id, T1], { dateFrom: t(2), name: null })
  await moment([Vic.id, T2, T3], { dateFrom: t(5), name: 'Friday natural wines' })
  await moment([Vic.id, T3], { dateFrom: t(9) })
  await moment([Vic.id, T2], { dateFrom: future, name: 'Later' }) // upcoming: never a "latest"
  await resetLimits()
  const tw = await call(tastedWithRoute.GET, 'GET', '/api/me/tasted-with', Vic)
  const people = (tw.json.people ?? []) as { id: number; name: string; imageUrl: string | null; followsViewer: boolean; lastMoment: { name: string | null; at: string } }[]
  check('🔒 tasted-with: every exclusion (followed, muted, blocked either way, self) runs before the limit', tw.status === 200 && people.length === 3, people.map(p => p.name))
  check('tasted-with order: latest shared moment first, then most moments together (Tim before Toni on the tie)', people.map(p => p.id).join() === [T1, T3, T2].join(), people.map(p => p.name))
  check('a nameless moment → lastMoment.name null; at = that moment\'s date', people[0]?.lastMoment.name === null && Math.abs(new Date(people[0]?.lastMoment.at).getTime() - t(2).getTime()) < 1000, people[0])
  check('lastMoment = the latest STARTED moment (the upcoming one never counts)', people[2]?.lastMoment.name === 'Friday natural wines', people[2])
  check('🔒 photos by each person\'s own tier (Tim is Friends-only: null), followsViewer', people[0]?.imageUrl === 'https://img.test/t1.jpg' && people[1]?.imageUrl === null && people[2]?.followsViewer === true && people[0]?.followsViewer === false, people)
  check('🔒 no moment code anywhere in the answer', !JSON.stringify(tw.json).includes(`PS${TAG.slice(-6)}`.toUpperCase()))
  check('tasted-with: 401 without a session', (await call(tastedWithRoute.GET, 'GET', '/api/me/tasted-with', {})).status === 401)

  // Search: ten blocked people sort first; the eleventh match must survive.
  const SQ = `Srch${TAG.slice(-5)}`
  const blockedHits: number[] = []
  for (let i = 0; i < 10; i++) blockedHits.push(await mkBare(`${SQ} A${i}`))
  await prisma.userBlock.createMany({ data: blockedHits.map((b, i) => (i % 2 ? { blockerId: b, blockedId: Vic.id } : { blockerId: Vic.id, blockedId: b })) })
  const Z = await mkBare(`${SQ} Zed`, { profileVisibility: 'public-mutual', imageUrl: 'https://img.test/z.jpg', xp: 3 })
  const Y = await mkBare(`${SQ} Yan`, { imageUrl: 'https://img.test/y.jpg' })
  await prisma.follow.createMany({ data: [...mutual(Y, F1), follow(Y, Vic.id)] })
  await moment([Vic.id, Y])
  const searchQ = async (q: string) => { await resetLimits(); return (await call(searchRoute.GET, 'GET', `/api/users/search?q=${encodeURIComponent(q)}`, Vic)).json as unknown as (Row & { gated?: true })[] }
  const hits = await searchQ(SQ)
  check('🔒 search drops block pairs (both ways) BEFORE the limit of ten', idsOf(hits) === want(Y, Z), hits.map(h => h.name))
  const y = hits.find(h => h.id === Y)!, z = hits.find(h => h.id === Z)!
  check('search row fields: photo, followsViewer, momentsTogether, friendsInCommon (Y ↔ F1, Vic follows F1)', y.imageUrl === 'https://img.test/y.jpg' && y.followsViewer && y.momentsTogether === 1 && y.friendsInCommon === 1, y)
  check('🔒 a tier-denied stub: gated, no photo / xp / friends in common, still its own edges', z.gated === true && z.imageUrl === null && z.xp === undefined && z.friendsInCommon === null && z.momentsTogether === 0, z)
  const selfQ = `Vic ${PS}`
  const vicName = (await prisma.user.findUnique({ where: { id: Vic.id }, select: { name: true } }))?.name ?? ''
  const selfHits = await searchQ(selfQ)
  check('search: you never find yourself (your name matches the query)', vicName.includes(selfQ) && !selfHits.some(h => h.id === Vic.id), selfHits.map(h => h.name))
  check('search: a literal % in q is not a wildcard', (await searchQ(`${SQ}%`)).length === 0)

  // The shell answer (Friends-only profiles Vic can't see).
  const G = await mkBare(`Gil ${PS}`, { profileVisibility: 'public-mutual' })
  await prisma.follow.create({ data: follow(G, Vic.id) })
  const shellG = await webProfile(G, Vic), shellF2 = await webProfile(F2, Vic)
  check('the shell carries followsYou: G follows Vic one way → followsYou true, isFollowing false (Follow Back)', shellG.json.gated === true && shellG.json.followsYou === true && shellG.json.isFollowing === false, shellG.json)
  check('…Vic follows F2 one way → isFollowing true, followsYou false; still no photo / stats', shellF2.json.gated === true && shellF2.json.isFollowing === true && shellF2.json.followsYou === false && !('imageUrl' in shellF2.json) && !('stats' in shellF2.json), shellF2.json)

  // The limiter: per user + a per-IP backstop, both charged after the 401.
  await resetLimits()
  await call(followersRoute.GET, 'GET', `/api/users/${Ola}/followers`, {}, undefined, { id: String(Ola) })
  check('people lists: an anonymous 401 charges no IP budget', (await scanKeys('rl:profile-people:*')).length === 0)
  await call(followersRoute.GET, 'GET', `/api/users/${Ola}/followers`, Vic, undefined, { id: String(Ola) })
  const rlKeys = await scanKeys('rl:profile-people:*')
  check('people lists: charged per user AND per IP', rlKeys.includes(`rl:profile-people:u:${Vic.id}:1m`) && rlKeys.some(k => k.startsWith('rl:profile-people:ip:')), rlKeys)

  // ── § 17 a moment's preview (the app's scan result) ──────────────────────
  section('§ 17 GET /api/session/:code/preview')
  const Hp = await mkUser('Hedda Preview'), Gp = await mkUser('Gus Preview')
  const Cp = await createSession(Hp, 'Hedda Preview')
  const preview = (u: Actor, code: string) => call(previewRoute.GET, 'GET', `/api/session/${code}/preview`, u, undefined, { code })
  await resetLimits()
  let pv = await preview(Gp, Cp)
  check('a guest: 200 with name, host, host id, joined false', pv.status === 200 && pv.json.name === `${TAG} moment` && pv.json.host === 'Hedda Preview' && pv.json.hostUserId === Hp.id && pv.json.joined === false && pv.json.code === Cp, pv.json)
  pv = await preview(Hp, `${Cp.slice(0, 4).toLowerCase()}-${Cp.slice(4)}`)
  check('the host (a lowercase, hyphenated code): joined true, the canonical code', pv.status === 200 && pv.json.joined === true && pv.json.code === Cp, pv.json)
  check('signed out → 401', (await preview({}, Cp)).status === 401)
  check('no such moment → 404', (await preview(Gp, 'ZZZZZZZZ')).status === 404)
  const previewHits = Number(await redis.get(`rl:moment-preview:u:${Gp.id}:1h`))
  check('🔒 its own budget, charged on every call and never reset by a hit (one valid code buys nothing)', previewHits === 2 && (await scanKeys('rl:moment-preview:ip:*')).length === 1 && (await scanKeys('rl:join:*')).length === 0, { previewHits })
  await prisma.userBlock.create({ data: { blockerId: Hp.id, blockedId: Gp.id } })
  pv = await preview(Gp, Cp)
  check('a block pair: still 200 (a block never stops a join), the host a plain name (no host id)', pv.status === 200 && pv.json.host === 'Hedda Preview' && pv.json.hostUserId === null, pv.json)
  await prisma.userBlock.deleteMany({ where: { blockerId: Hp.id, blockedId: Gp.id } })
  await prisma.userBlock.create({ data: { blockerId: Gp.id, blockedId: Hp.id } })
  check('…the other direction too', (await preview(Gp, Cp)).json.hostUserId === null)
  await prisma.userBlock.deleteMany({ where: { blockerId: Gp.id, blockedId: Hp.id } })
  await redis.set(`rl:moment-preview:u:${Gp.id}:1h`, '60', { EX: 3600 })
  pv = await preview(Gp, Cp)
  check('past 60 an hour → 429 with a wait', pv.status === 429 && /Try again in/.test(String(pv.json.error)), pv)
} catch (err) {
  // A fixture throw must fail the run: `finally` exits with the check count.
  failed++
  console.log(`  ❌ the suite crashed: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  await prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${`${TAG}-cap-%`}`.catch(() => {})
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
  fake.close()
  process.exit(failed > 0 ? 1 : 0)
}
