// You profile, step 2 — integration suite (.local/you-profile/step2-plan.md
// § Verification). Drives the REAL route handlers and lib functions (tsx)
// against a throwaway Postgres + Redis:
//   § 1 bio normalisation + PATCH /api/me/profile (rename tail, validation)
//   § 2 tile pools + pins (PICK vs LIVE, D3 re-hide, D7 deleted moment, the
//       dead-pin clear, the clear vs a same-URL re-pick on the locked row)
//   § 3 D8: a moment deletion keeps rated / bookmarked wine photos
//   § 4 D9: account deletion (wiped moment two-phase, surviving moment keeps
//       every photo, rolled-back attempt reclaims nothing, avatar + cover)
//   § 5 the profile image replace protocol (no orphan under concurrency, a
//       replace blocked on an account deletion reclaims its own upload)
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
const usersRoute = await import('../../app/api/users/[id]/route.ts')
const { listPickable, resolveTilePhotos } = await import('../../lib/profileTiles.ts')
const { replaceProfileImage } = await import('../../lib/profileImage.ts')
const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')

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
type User = { id: number; cookie: string }
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
  return { id: row.id, cookie: (headers.get('set-cookie') ?? '').split(';')[0] }
}
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
  const read = resolveTilePhotos(P.id)
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
} finally {
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
  fake.close()
  process.exit(failed > 0 ? 1 : 0)
}
