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
//   Public user ids (docs/dev/proposals/public-user-ids.md § 9):
//   § 18 the wire walk (every surface emits public ids), the inputs (the
//        fixture's integer is malformed on EVERY input route), the null paths
//        (blocked-me == unknown, limiter spent too), a deleted participant,
//        the sealed people cursor + newest follow first, auth through the
//        route module (sign-up free == taken, publicId refused, get-session,
//        /list-accounts), schema triggers + CHECKs, Redis, tile ownership by
//        row, the blocks / bans list photos, the re-key script
//   The profile lists (.local/you-profile/lists-plan.md § Verification):
//   § 19 the D4 state matrix over the SQL rule + SAFE_PHOTO
//        (scripts/tests/outside-view-matrix.mts, mutation-checked), the
//        hidden-line-up write refusal (anon host keeps pre-rating), the three
//        lists (gate states, Show switches, block pairs, blind rows, hidden
//        line-ups, both had, search, score range, paging + the had_at order
//        after a re-rate), tile count == list total across D4 states, the
//        sealed cravings cursor (score boundary, sort served as recent),
//        someone's moments (codes only where you are a current member, the
//        shared filter), ?item=, the feed's hidden posts left out before
//        paging (nextCursor, a mixed page on the feed and profileLoad),
//        /api/me/ratings + /api/me/bookmarks
//   The leak fixes (.local/leak-fixes/plan.md § 5), scripts/tests/leak-fixes-section.mts:
//   § 20 b the entrance gate: the route sweep (a spent budget answers every
//        code alike on every moment route, nothing rebuilt, members pass),
//        the budgets per surface and code length, the atomic charge, the
//        joins, the kicked bounce, the primitive, the admission query
//   Usernames (docs/dev/proposals/usernames.md § 12), scripts/tests/usernames-section.mts:
//   § 21 the format CHECK vs the core validator, the hold triggers, the rename
//        quota, races on two connections with their negative controls, honest
//        one-step sign-up (app + web), by-username = the id route, `username`
//        on every person outside a moment and never inside one, search, the
//        limits, the writes census
//   Moment Visibility, step 1a (docs/dev/proposals/moment-visibility.md),
//   scripts/tests/moment-visibility-section.mts:
//   § 23 sessions.public_id + the CHECKs and triggers, a real create's
//        defaults, a promotion landing closed, the visibility GET / PATCH and
//        the look-in link (who, the flag after the entrance gate, the freeze,
//        the secret failing closed, the shared limiter), the scrub gate on
//        both delete paths, the migration's one-off statements run for real,
//        guests' `shown`, blind rows without a wine id
//   + the CANARY over every response of the run (no user integer leaves)
//
// S3 is an in-process FAKE endpoint that records every PUT / DELETE the AWS
// SDK actually sends, so "reclaimed" / "survives" is observed on the wire,
// not inferred. CI has no S3; this needs none.
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/you-profile-integration.mts
import { nanoid } from 'nanoid'
import { linkLegacy } from './lib/catalogFixture.mts'
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
// Each object's LastModified (the listing reports it; § 20 c backdates some).
const mtimes = new Map<string, number>()
const puts: string[] = []
const deletes: string[] = []
const fake = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const key = decodeURIComponent(new URL(req.url ?? '/', 'http://s3').pathname).replace(/^\/verre\//, '')
    // CopyObject ("had a sip") is a PUT with x-amz-copy-source; the SDK needs the XML result.
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      store.add(key); mtimes.set(key, Date.now()); puts.push(key); res.writeHead(200, { 'Content-Type': 'application/xml' })
      return res.end('<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"fake"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>')
    }
    if (req.method === 'PUT') { store.add(key); mtimes.set(key, Date.now()); puts.push(key); res.writeHead(200, { ETag: '"fake"' }); return res.end() }
    if (req.method === 'DELETE') { store.delete(key); mtimes.delete(key); deletes.push(key); res.writeHead(204); return res.end() }
    // ListObjectsV2 (the re-key script's discovery, § 18).
    const q = new URL(req.url ?? '/', 'http://s3').searchParams
    if (req.method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? ''
      const keys = [...store].filter(x => x.startsWith(prefix)).sort()
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>verre</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${keys.map(x => `<Contents><Key>${x}</Key><LastModified>${new Date(mtimes.get(x) ?? Date.now()).toISOString()}</LastModified><Size>1</Size></Contents>`).join('')}</ListBucketResult>`)
    }
    res.writeHead(store.has(key) ? 200 : 404, store.has(key) ? { 'Content-Type': 'image/png' } : {}); res.end()
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
const { fixtureUsername } = await import('./lib/fixtureUsername.mjs')
const { syncCredential } = await import('../../lib/identityStore.ts')
const { default: bcrypt } = await import('bcrypt')
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
// § 19 the profile lists (.local/you-profile/lists-plan.md)
const impressionsRoute = await import('../../app/api/users/[id]/impressions/route.ts')
const momentsListRoute = await import('../../app/api/users/[id]/moments/route.ts')
const cravingsRoute = await import('../../app/api/users/[id]/cravings/route.ts')
const meRatingsRoute = await import('../../app/api/me/ratings/route.ts')
const meBookmarksRoute = await import('../../app/api/me/bookmarks/route.ts')
const bookmarkRoute = await import('../../app/api/session/[code]/wines/[wineId]/bookmark/route.ts')
const bookmarkByIdRoute = await import('../../app/api/me/bookmarks/[id]/route.ts')
const postCraveRoute = await import('../../app/api/feed-items/[id]/crave/route.ts')
const { outsideViewMatrix } = await import('./outside-view-matrix.mts')
// § 20 the leak fixes (.local/leak-fixes/plan.md)
const { leakFixes } = await import('./leak-fixes-section.mts')
// § 21 usernames (docs/dev/proposals/usernames.md § 12)
const { usernames } = await import('./usernames-section.mts')
// § 23 Moment Visibility, step 1a
const { momentVisibility } = await import('./moment-visibility-section.mts')
// § 18 public user ids
const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const unbanRoute = await import('../../app/api/session/[code]/bans/[identityId]/route.ts')
const banPreviewRoute = await import('../../app/api/session/[code]/bans/preview/[identityId]/route.ts')
const removedStateRoute = await import('../../app/api/session/[code]/removed-state/route.ts')
const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
const reorderRoute = await import('../../app/api/session/[code]/wines/reorder/route.ts')
const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
const meSessionsRoute = await import('../../app/api/me/sessions/route.ts')
const friendsRoute = await import('../../app/api/me/friends/route.ts')
const blocksListRoute = await import('../../app/api/me/blocks/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const followRoute = await import('../../app/api/users/[id]/follow/route.ts')
const nativeAuthRoute = await import('../../app/api/auth/native/[...all]/route.ts')
const publicIds = await import('../../lib/publicIds.ts')
const rekey = await import('../rekey-user-images.mts')
const { canViewPosts, viewableProfiles } = await import('../../lib/profileVisibility.ts')
const { canonicalPostAudience, applyVisibilityChanges } = await import('../../packages/core/src/index.ts')
const { ensureBadgesSeedOnce } = await import('../../lib/badgeService.ts')
const { ALL_BADGES } = await import('../../lib/badges.ts')
const { resolveUser } = await import('../../lib/resolveUser.ts')
const { listPickable, resolveTilePhotos, isLegacyOwnTileUpload, isOwnTile } = await import('../../lib/profileTiles.ts')
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
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
const BASE = 'http://localhost:3000'
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

// ── The canary (public-user-ids § 9): "the integer never leaves" ────────────
// Every fixture user is minted at ≥ 900000000 (setval below), so a whole
// number of that size in a response can only be a user id. EVERY response the
// harness sees (call(), and the direct calls via canary()) is scanned RAW, body
// and headers: no fixture user integer as a whole number, no `u:` + a digit
// (public ids start with a letter), no fixture user's integer or public id
// inside an image URL. Old sections then get a TRANSLATED copy (wire ids back to
// integers) so their assertions stay about what they test; § 18 asserts the
// wire shape itself.
const PIDRE = /^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$/
const canaryViolations: string[] = []
async function fixtureIds(): Promise<{ ints: number[]; pids: Map<string, number> }> {
  const rows = await prisma.$queryRaw<{ id: number; public_id: string }[]>`SELECT id, public_id FROM users WHERE id >= 900000000`
  return { ints: rows.map(r => r.id), pids: new Map(rows.map(r => [r.public_id, r.id])) }
}
async function canary(where: string, text: string, headers: Headers) {
  const { ints, pids } = await fixtureIds()
  const hdrs = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
  for (const [part, src] of [['body', text], ['headers', hdrs]] as const) {
    if (/u:\d/.test(src)) canaryViolations.push(`${where} ${part}: u:<digit>`)
    if (ints.length) {
      const re = new RegExp(`(?<![0-9])(?:${ints.join('|')})(?![0-9])`)
      const m = re.exec(src)
      if (m) canaryViolations.push(`${where} ${part}: user integer ${m[0]}`)
    }
  }
  for (const url of text.match(/https?:\/\/[^"\s\\]+/g) ?? []) {
    for (const pid of pids.keys()) if (url.includes(pid)) canaryViolations.push(`${where}: public id in a URL`)
  }
}
async function toInternal(v: unknown, field?: string): Promise<unknown> {
  if (typeof v === 'string') {
    const { pids } = await fixtureIdsCached()
    if (v.startsWith('u:') && PIDRE.test(v.slice(2))) { const n = pids.get(v.slice(2)) ?? (await pidLookup(v.slice(2))); return n === null ? v : `u:${n}` }
    if (field && /^(id|hostUserId|addedByUserId|userId)$/.test(field) && PIDRE.test(v)) { const n = pids.get(v) ?? (await pidLookup(v)); return n ?? v }
    return v
  }
  if (Array.isArray(v)) return Promise.all(v.map(x => toInternal(x)))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[(await toInternal(k)) as string] = await toInternal(x, k)
    return out
  }
  return v
}
let idCache: { at: number; v: Awaited<ReturnType<typeof fixtureIds>> } | null = null
async function fixtureIdsCached() { if (!idCache || Date.now() - idCache.at > 2000) idCache = { at: Date.now(), v: await fixtureIds() }; return idCache.v }
async function pidLookup(pid: string): Promise<number | null> {
  const r = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE public_id = ${pid}`
  return r[0]?.id ?? null
}
const pidOf = async (id: number) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { publicId: true } })).publicId

async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}, extra: Record<string, string> = {}) {
  // Catalogue model change step 4: a typed bottle becomes a minted entry + its pick.
  body = await linkLegacy(method, path, body)
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (actor.cookie) headers.cookie = actor.cookie
  if (actor.anon) headers['x-vr-anon-token'] = actor.anon
  const req = new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) })
  const text = await res.text()
  await canary(`${method} ${path}`, text, res.headers)
  let wire: unknown = null
  try { wire = JSON.parse(text) } catch {}
  return { status: res.status, json: (await toInternal(wire)) as Record<string, any>, wire: wire as Record<string, any>, headers: res.headers } // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
}
let userSeq = 0
// Every other fixture user has NO username: an account from before usernames
// (a credential and a sign-in, no sign-up), which is what every account is
// right after the deploy. `username: true` forces one (§ 21 needs them).
async function mkUser(name: string, opts: { username?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const password = `pw-${TAG}-${userSeq}`
  if (!(opts.username ?? userSeq % 2 === 0)) {
    const created = await prisma.user.create({ data: { name, email }, select: { id: true, publicId: true } })
    await syncCredential(created.id, await bcrypt.hash(password, 4))
    const signedIn = await betterAuthServer.api.signInEmail({ body: { email, password }, returnHeaders: true })
    return { id: created.id, pid: created.publicId, cookie: (signedIn.headers.get('set-cookie') ?? '').split(';')[0], email, password }
  }
  // One step since usernames (§ 9): sign-up needs a username and creates the
  // session itself, so the cookie comes FROM the sign-up (`returnHeaders`: the
  // signed set-cookie; the body's `token` is the raw token) and a fixture user
  // still has exactly one native session.
  const { headers } = await betterAuthServer.api.signUpEmail({ body: { name, email, password, username: fixtureUsername() } as never, returnHeaders: true })
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, publicId: true } })
  return { id: row.id, pid: row.publicId, cookie: (headers.get('set-cookie') ?? '').split(';')[0], email, password }
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
  const id = nanoid()
  const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, u, { id, name, type: 'red' }, { code })
  if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
  // The photo has its own call since the catalogue model change (step 3).
  const img = await call((await import('../../app/api/session/[code]/wines/[wineId]/image/route.ts')).PUT, 'PUT', `/api/session/${code}/wines/${id}/image`, u, { image: PNG }, { code, wineId: id })
  if (img.status !== 200) throw new Error(`wine photo failed ${img.status} ${JSON.stringify(img.json)}`)
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
  const pid = await pidOf(id)
  const r = await call(usersRoute.GET, 'GET', `/api/users/${pid}?view=header`, viewer, undefined, { id: pid })
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

// The canary range: every user this suite creates gets an id ≥ 900000000
// (GREATEST keeps a local re-run monotonic).
await prisma.$queryRaw`SELECT setval('users_id_seq', GREATEST(900000000, (SELECT COALESCE(max(id), 0) FROM users)))`

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
  // 🔒 Keys carry nothing that points to the person (D2): `avatars/avatar_<rand>`.
  const prefix = 'avatars/avatar_'
  const putMark = puts.length
  const results = await Promise.all([1, 2, 3, 4].map(() => replaceProfileImage(Q.id, 'avatar', PNG)))
  const qPuts = puts.slice(putMark).filter(p => p.startsWith(prefix))
  const [{ image_url: finalAvatar }] = await prisma.$queryRaw<{ image_url: string | null }[]>`SELECT image_url FROM users WHERE id = ${Q.id}`
  const live = qPuts.filter(p => store.has(p))
  check('🔒 avatar keys: the kind marker + a random part, no user id or public id', qPuts.every(p => /^avatars\/avatar_[0-9a-f]{32}\.png$/.test(p) && !p.includes(String(Q.id)) && !p.includes(Q.pid)), qPuts)
  check('4 concurrent replaces: 4 distinct keys uploaded', results.every(x => x.ok) && new Set(qPuts).size === 4, qPuts)
  check('…exactly ONE object left, the one the row points at (no orphan)', live.length === 1 && urlOf(live[0]) === finalAvatar, { live, finalAvatar })
  await resetLimits()
  let rr = await call(avatarRoute.POST, 'POST', '/api/me/avatar', Q, { imageData: PNG })
  check('avatar route: same wire contract { imageUrl }, prior reclaimed', rr.status === 200 && typeof rr.json.imageUrl === 'string' && !store.has(keyOf(finalAvatar)), rr)
  rr = await call(avatarRoute.DELETE, 'DELETE', '/api/me/avatar', Q)
  check('avatar DELETE → { ok }, nothing of Q\'s avatars left', rr.status === 200 && rr.json.ok === true && !puts.slice(putMark).filter(p => p.startsWith(prefix)).some(p => store.has(p)))
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: PNG })
  const firstCover = rr.json.coverPhotoUrl as string
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: PNG })
  check('cover route: { coverPhotoUrl } under avatars/cover_<rand> (no user), the replaced one reclaimed', rr.status === 200 && /^avatars\/cover_[0-9a-f]{32}\.png$/.test(keyOf(rr.json.coverPhotoUrl)) && !store.has(keyOf(firstCover)) && store.has(keyOf(rr.json.coverPhotoUrl)), rr)
  rr = await call(coverRoute.POST, 'POST', '/api/me/cover', Q, { imageData: 'data:text/plain;base64,aGk=' })
  check('a rejected (non-image) upload → 500, the stored cover unchanged', rr.status === 500 && (await prisma.user.findUnique({ where: { id: Q.id }, select: { coverPhotoUrl: true } }))?.coverPhotoUrl !== null)

  const Q2 = await mkUser('Quill Gone')
  const g = gate()
  let atHook = false
  const del = deleteAccountDurable(Q2.id, { hooks: { beforeUserDelete: async () => { atHook = true; await g.p } } })
  for (let i = 0; !atHook && i < 500; i++) await sleep(20)
  if (!atHook) throw new Error('account deletion never reached beforeUserDelete')
  const lateMark = puts.length
  const late = replaceProfileImage(Q2.id, 'cover', PNG)
  check('a replace racing the account deletion blocks on the users-row lock', await blockedOnLock(late))
  g.open()
  await del
  const lr = await late
  const lateKeys = puts.slice(lateMark).filter(p => p.startsWith('avatars/cover_'))
  check('…finds no row and reclaims its OWN upload', !lr.ok && lr.reason === 'gone' && lateKeys.length === 1 && !store.has(lateKeys[0]), { lr, lateKeys })

  // ── § 5b a tile's own photo ───────────────────────────────────────────────
  section('§ 5b a tile\'s own photo: upload, always live, reclaimed only when owned')
  const T = await mkUser('Tilda Tiles')
  const ownKey = (k: string) => isLegacyOwnTileUpload(urlOf(k), 'impressions', T.id)
  check('legacy own key (until the re-key): this tile + this user, the last path segment only', ownKey(`avatars/tile_impressions_u_${T.id}_1_ab.png`) && !ownKey(`avatars/tile_impressions_u_${T.id}5_1_ab.png`) && !ownKey(`avatars/tile_moments_u_${T.id}_1_ab.png`) && !ownKey(`avatars/tile_impressions_u_${T.id}_/x.png`) && !isLegacyOwnTileUpload(null, 'impressions', T.id))
  check('isOwnTile: url = own_url, or the legacy key; null / another url never', isOwnTile('x', 'x', 'impressions', T.id) && !isOwnTile('x', 'y', 'impressions', T.id) && !isOwnTile(null, null, 'impressions', T.id) && isOwnTile(urlOf(`avatars/tile_impressions_u_${T.id}_1_ab.png`), null, 'impressions', T.id))
  const postTile = async (u: User, tile: string, imageData = PNG) => { await resetLimits(); return call(tilesRoute.POST, 'POST', `/api/me/profile/tiles/${tile}`, u, { imageData }, { tile }) }
  let tr = await postTile(T, 'impressions')
  const own1 = tr.json.tiles?.impressions?.imageUrl as string
  const ownUrlOf = async (id: number) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { tileImpressionsOwnUrl: true } })).tileImpressionsOwnUrl
  check('upload → 200, pinned, keyed avatars/tile_impressions_<rand> (no user), own_url = url', tr.status === 200 && tr.json.tiles.impressions.pinned === true && /^avatars\/tile_impressions_[0-9a-f]{32}\.png$/.test(keyOf(own1)) && store.has(keyOf(own1)) && (await pins(T.id)).i === own1 && (await ownUrlOf(T.id)) === own1, tr.json)
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
    const r = await call(muteRoute.POST, 'POST', `/api/me/mutes/${t.pid}`, M, undefined, { id: t.pid })
    if (r.status !== 200) throw new Error(`mute ${r.status}`)
    await sleep(5)
  }
  const blockedMe = await call(blockRoute.POST, 'POST', `/api/me/blocks/${M.pid}`, m3, undefined, { id: M.pid })
  const iBlocked = await call(blockRoute.POST, 'POST', `/api/me/blocks/${m4.pid}`, M, undefined, { id: m4.pid })
  check('fixture: both blocks land', blockedMe.status === 200 && iBlocked.status === 200, [blockedMe.status, iBlocked.status])
  await resetLimits()
  const ml = await call(mutesRoute.GET, 'GET', '/api/me/mutes', M)
  const ids = (ml.json?.mutes ?? []).map((m: { id: number }) => m.id)
  check('200 with { mutes: [{ id (public), name, createdAt }] }, no imageUrl', ml.status === 200 && ml.wire.mutes.every((m: Record<string, unknown>) => typeof m.id === 'string' && PIDRE.test(m.id as string) && typeof m.name === 'string' && typeof m.createdAt === 'string' && !('imageUrl' in m)), ml.wire)
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
  const ci0 = await call(checkinsRoute.POST, 'POST', '/api/checkins', O, {
    occurrenceId: nanoid(), wineName: `${TAG} Standalone`, score: 4, flavors: {}, ...VENUE, lat: 47.5, lng: 7.6,
    wineRegion: 'Douro', wineCountry: 'PT',
  })
  if (ci0.status !== 201) throw new Error(`check-in POST ${ci0.status} ${JSON.stringify(ci0.json)}`)
  const postId = ci0.json.id as number
  // The photo attaches through the check-in's own PATCH (catalogue model change step 3).
  await resetLimits()
  const ci = await call((await import('../../app/api/checkins/[id]/route.ts')).PATCH, 'PATCH', `/api/checkins/${postId}`, O, { imageData: PNG }, { id: String(postId) })
  if (ci.status !== 200) throw new Error(`check-in photo PATCH ${ci.status} ${JSON.stringify(ci.json)}`)
  check('D12 + D2: the check-in photo key is random, with nothing that points to the person', /^wines\/ci_[0-9a-f]{32}\.png$/.test(keyOf(ci.json.imageUrl)), keyOf(ci.json.imageUrl))
  const OM = await createSession(O, 'Olga Owner')
  const ow = await addWine(OM, O, 'Moment Bottle')
  await rate(OM, O, ow.id)
  await bookmark(O.id, ow.id)
  await ensureBadgesSeedOnce()
  await prisma.userBadge.create({ data: { userId: O.id, badgeId: ALL_BADGES[0].id } })

  const feedOf = async (v: User, user?: number) => call(feedRoute.GET, 'GET', user ? `/api/feed?user=${await pidOf(user)}` : '/api/feed', v)
  const oItems = (f: { json: Record<string, any> }) => ((f.json?.items ?? []) as { author: { id: number } }[]).filter(i => i.author.id === O.id) // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  const oCheckin = (f: { json: Record<string, any> }) => (oItems(f) as unknown as { type: string; checkin?: Record<string, unknown> }[]).find(i => i.type === 'checkin')?.checkin // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  const webProfile = async (id: number, v: User | Actor) => { await resetLimits(); const pid = await pidOf(id); return call(usersRoute.GET, 'GET', `/api/users/${pid}`, v, undefined, { id: pid }) }
  const like = async (v: User, method: 'POST' | 'DELETE') => { await resetLimits(); return call(method === 'POST' ? likeRoute.POST : likeRoute.DELETE, method, `/api/feed-items/${postId}/like`, v, undefined, { id: String(postId) }) }
  const sip = async (v: User) => { await resetLimits(); return call(checkinsRoute.POST, 'POST', '/api/checkins', v, { occurrenceId: nanoid(), wineName: `${TAG} sip`, score: 3, flavors: {}, copyFromCheckinId: postId }) }

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
  const bOther = await call(badgesRoute.GET, 'GET', `/api/users/${O.pid}/badges`, Rf, undefined, { id: O.pid })
  const bOwn = await call(badgesRoute.GET, 'GET', `/api/users/${O.pid}/badges`, O, undefined, { id: O.pid })
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
  const owPost = await call(checkinsRoute.POST, 'POST', '/api/checkins', Ow, { occurrenceId: nanoid(), wineName: `${TAG} circle`, score: 4, flavors: {} })
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
    const pid = await pidOf(id)
    const r = await call(dir === 'followers' ? followersRoute.GET : followingRoute.GET, 'GET', `/api/users/${pid}/${dir}${qs}`, v, undefined, { id: pid })
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
  await call(followersRoute.GET, 'GET', `/api/users/${await pidOf(Ola)}/followers`, {}, undefined, { id: await pidOf(Ola) })
  check('people lists: an anonymous 401 charges no IP budget', (await scanKeys('rl:profile-people:*')).length === 0)
  await call(followersRoute.GET, 'GET', `/api/users/${await pidOf(Ola)}/followers`, Vic, undefined, { id: await pidOf(Ola) })
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
  // ── § 18 public user ids (public-user-ids § 9) ───────────────────────────
  {
  section('§ 18 public user ids: the wire, inputs, null paths, auth, schema, images, people order')
  const isPid = (v: unknown) => typeof v === 'string' && PIDRE.test(v)
  const isWireU = (v: unknown) => typeof v === 'string' && v.startsWith('u:') && PIDRE.test(v.slice(2))
  const UNKNOWN = 'ZZZZZZZZZZZZ'
  check('setup: the unknown fixture id is not minted', !(await prisma.user.findFirst({ where: { publicId: UNKNOWN } })))
  const Ap = await mkUser('Ada Public'), Bp = await mkUser('Ben Public'), Cq = await mkUser('Cy Public')
  check('fixture users carry well-formed public ids, integers in the canary range', [Ap, Bp, Cq].every(u => isPid(u.pid) && u.id >= 900000000))
  await prisma.follow.createMany({ data: [{ followerId: Ap.id, followingId: Bp.id }, { followerId: Bp.id, followingId: Ap.id }] })

  // (1) The walk: every surface, ids are public.
  await resetLimits()
  let w = await call(usersRoute.GET, 'GET', `/api/users/${Bp.pid}`, Ap, undefined, { id: Bp.pid })
  check('profile: id is the public id', w.status === 200 && w.wire.id === Bp.pid, w.wire)
  await resetLimits()
  w = await call(usersRoute.GET, 'GET', `/api/users/${Bp.pid.toLowerCase()}`, Ap, undefined, { id: Bp.pid.toLowerCase() })
  check('profile: input is case-insensitive, the answer canonical', w.status === 200 && w.wire.id === Bp.pid)
  for (const [dir, route] of [['followers', followersRoute], ['following', followingRoute]] as const) {
    await resetLimits()
    const r = await call(route.GET, 'GET', `/api/users/${Ap.pid}/${dir}`, Bp, undefined, { id: Ap.pid })
    check(`people ${dir}: rows carry public ids`, r.status === 200 && r.wire.users.length > 0 && r.wire.users.every((u: { id: unknown }) => isPid(u.id)), r.wire)
  }
  await resetLimits()
  w = await call(searchRoute.GET, 'GET', `/api/users/search?q=${encodeURIComponent('Ben Public')}`, Ap)
  check('search: public ids', Array.isArray(w.wire) && w.wire.some((h: { id: unknown }) => h.id === Bp.pid), w.wire)
  await resetLimits()
  w = await call(friendsRoute.GET, 'GET', '/api/me/friends', Ap)
  check('friends (the tag picker): public ids', Array.isArray(w.wire) && w.wire.some((f: { id: unknown }) => f.id === Bp.pid))
  await resetLimits()
  const ci1 = await call(checkinsRoute.POST, 'POST', '/api/checkins', Bp, { occurrenceId: nanoid(), wineName: 'Public Bottle', score: 4, taggedUserIds: [Ap.pid, UNKNOWN] })
  check('check-in POST: tags by public id (an unknown one dropped), echo userId public', ci1.status === 201 && ci1.wire.userId === Bp.pid, { status: ci1.status, userId: ci1.wire.userId, want: Bp.pid })
  const ciId = ci1.wire.id as number
  const tagRows = await prisma.feedItemTag.findMany({ where: { feedItemId: ciId }, select: { userId: true } })
  check('…the stored tag is Ap (the unknown id dropped like a non-mutual)', tagRows.length === 1 && tagRows[0].userId === Ap.id, tagRows)
  await resetLimits()
  w = await call(feedRoute.GET, 'GET', '/api/feed', Ap)
  const bItem = (w.wire.items as { type: string; author: { id: unknown }; checkin?: { id: number; tags: { id: unknown }[] } }[]).find(i => i.checkin?.id === ciId)
  check('feed: author + tags are public ids', !!bItem && bItem.author.id === Bp.pid && bItem.checkin!.tags.every(t => t.id === Ap.pid), bItem)
  await resetLimits()
  w = await call(feedRoute.GET, 'GET', `/api/feed?user=${Bp.pid}`, Ap)
  check('feed ?user=<publicId>: that author\'s posts', w.status === 200 && (w.wire.items as { author: { id: unknown } }[]).every(i => i.author.id === Bp.pid) && w.wire.items.length > 0)
  await resetLimits()
  let pr = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${ciId}`, Bp, { taggedUserIds: [String(Ap.id)] }, { id: String(ciId) })
  check('🔒 check-in PATCH with an integer tag list → 400 for the whole request', pr.status === 400, pr.wire)
  pr = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${ciId}`, Bp, { taggedUserIds: [Ap.id] }, { id: String(ciId) })
  check('…numbers too → 400', pr.status === 400, pr.wire)
  check('…and the stored tags are intact (never wiped to [])', (await prisma.feedItemTag.count({ where: { feedItemId: ciId } })) === 1)
  const postsBefore = await prisma.feedItem.count({ where: { userId: Bp.id } })
  await resetLimits()
  pr = await call(checkinsRoute.POST, 'POST', '/api/checkins', Bp, { occurrenceId: nanoid(), wineName: 'Old Tab Bottle', score: 3, taggedUserIds: [Ap.id] })
  check('🔒 check-in POST with an integer tag → 400 and no post created', pr.status === 400 && (await prisma.feedItem.count({ where: { userId: Bp.id } })) === postsBefore, pr.wire)
  await resetLimits()
  pr = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${ciId}`, Bp, { taggedUserIds: [Ap.pid] }, { id: String(ciId) })
  check('check-in PATCH echo: userId public', pr.status === 200 && pr.wire.userId === Bp.pid, pr.wire)

  // A moment, with a cover chosen at creation (§ 8a c).
  await resetLimits()
  const cr = await call(sessionRoute.POST, 'POST', '/api/session', Ap, { hostDisplayName: 'Ada Public', sessionName: `${TAG} public moment`, dateFrom, coverPhoto: PNG })
  const Pm = cr.wire.code as string
  check('create: id = u:<publicId>', cr.status === 200 && cr.wire.id === `u:${Ap.pid}`, cr.wire)
  check('🔒 the cover chosen at creation has the settings path\'s random key (no timestamp, no code)', /^sessions\/[A-Za-z0-9_-]{16}\.png$/.test(keyOf(cr.wire.coverPhotoUrl)), keyOf(cr.wire.coverPhotoUrl))
  await resetLimits()
  const jr = await call(joinRoute.POST, 'POST', '/api/session/join', Bp, { code: Pm, displayName: 'Ben' })
  check('join: id + meta wire (hostUserId public, hostIdentityId u:<publicId>)', jr.status === 200 && jr.wire.id === `u:${Bp.pid}` && jr.wire.hostUserId === Ap.pid && jr.wire.hostIdentityId === `u:${Ap.pid}`, jr.wire)
  const vr = await call(visitRoute.POST, 'POST', `/api/session/${Pm}/visit`, Bp, {}, { code: Pm })
  check('visit: id = u:<publicId>', vr.status === 200 && vr.wire.id === `u:${Bp.pid}`, vr.wire)
  await resetLimits()
  const sr = await call(codeRoute.PATCH, 'PATCH', `/api/session/${Pm}`, Ap, { action: 'set-role', targetId: `u:${Bp.pid}`, role: 'provider' }, { code: Pm })
  check('set-role by u:<publicId>: echo meta providerIds wire', sr.status === 200 && (sr.wire.meta.providerIds as string[]).includes(`u:${Bp.pid}`) && sr.wire.meta.hostUserId === Ap.pid, sr.wire)
  await resetLimits()
  const wb = await call(winesRoute.POST, 'POST', `/api/session/${Pm}/wines`, Bp, { id: nanoid(), name: 'Ben Brought', type: 'red' }, { code: Pm })
  check('wine POST echo: addedByUserId public', wb.status === 200 && wb.wire.addedByUserId === Bp.pid, wb.wire)
  const wa = await call(winesRoute.POST, 'POST', `/api/session/${Pm}/wines`, Ap, { id: nanoid(), name: 'Ada Brought', type: 'white' }, { code: Pm })
  await rate(Pm, Bp, wb.wire.id)
  await resetLimits()
  const st = await call(stateRoute.GET, 'GET', `/api/session/${Pm}/state`, Bp, undefined, { code: Pm })
  check('state: participants, roles, ratings keys and wine adders are wire ids', st.status === 200
    && (st.wire.meta.participants as { id: string }[]).every(p => isWireU(p.id) || p.id.startsWith('a:'))
    && (st.wire.meta.participants as { id: string }[]).some(p => p.id === `u:${Bp.pid}`)
    && Object.keys(st.wire.ratings).every(isWireU) && Object.keys(st.wire.ratings).includes(`u:${Bp.pid}`)
    && (st.wire.wines as { addedByUserId: unknown }[]).every(x => x.addedByUserId === null || isPid(x.addedByUserId)), st.wire)
  await resetLimits()
  const pe = await call(wineRoute.PATCH, 'PATCH', `/api/session/${Pm}/wines/${wb.wire.id}`, Ap, { name: 'Ben Brought', type: 'red', producer: 'P' }, { code: Pm, wineId: wb.wire.id })
  check('wine PATCH echo: addedByUserId public', pe.status === 200 && pe.wire.addedByUserId === Bp.pid, pe.wire)
  await resetLimits()
  const ro = await call(reorderRoute.POST, 'POST', `/api/session/${Pm}/wines/reorder`, Ap, { orderedIds: [wa.wire.id, wb.wire.id] }, { code: Pm })
  check('reorder echo: addedByUserId public', ro.status === 200 && (ro.wire as unknown as { addedByUserId: unknown }[]).every(x => isPid(x.addedByUserId)), ro.wire)
  await resetLimits()
  const rv = await call(revealRoute.POST, 'POST', `/api/session/${Pm}/wines/${wb.wire.id}/reveal`, Ap, {}, { code: Pm, wineId: wb.wire.id })
  check('reveal echo: addedByUserId public', rv.status === 200 && rv.wire.wine.addedByUserId === Bp.pid, rv.wire)
  // The saves (catalogue model change step 5): each answer goes through the canary.
  await resetLimits()
  const sv = await call(bookmarkRoute.POST, 'POST', `/api/session/${Pm}/wines/${wb.wire.id}/bookmark`, Bp, undefined, { code: Pm, wineId: wb.wire.id })
  check('save in the moment → { ok, saved }', sv.status === 200 && sv.wire.saved === true, sv.wire)
  const savedW = await call(meBookmarksRoute.GET, 'GET', '/api/me/bookmarks', Bp)
  check('Saved: 200, one wine', savedW.status === 200 && Array.isArray(savedW.wire) && savedW.wire.length === 1, savedW.wire)
  const theirC = await call(cravingsRoute.GET, 'GET', `/api/users/${Bp.pid}/cravings`, Ap, undefined, { id: Bp.pid })
  check('someone\'s Cravings: 200, the row', theirC.status === 200 && theirC.wire.items.length === 1, theirC.wire)
  const ciWine = (await prisma.$queryRaw<{ w: string }[]>`SELECT r.wine_id AS w FROM feed_items f JOIN ratings r ON r.id = f.rating_id WHERE f.id = ${ciId}`)[0].w
  const pc = await call(postCraveRoute.POST, 'POST', `/api/feed-items/${ciId}/crave`, Ap, { wineId: ciWine }, { id: String(ciId) })
  check('save from a post → { ok, saved }', pc.status === 200 && pc.wire.saved === true, pc.wire)
  const pcu = await call(postCraveRoute.DELETE, 'DELETE', `/api/feed-items/${ciId}/crave`, Ap, { wineId: ciWine }, { id: String(ciId) })
  check('unsave from a post → { ok, saved: false }', pcu.status === 200 && pcu.wire.saved === false, pcu.wire)
  const bkId = (await prisma.bookmark.findFirstOrThrow({ where: { userId: Bp.id }, select: { id: true } })).id
  const rmv = await call(bookmarkByIdRoute.DELETE, 'DELETE', `/api/me/bookmarks/${bkId}`, Bp, undefined, { id: String(bkId) })
  check('remove a craving by its id → 200', rmv.status === 200, rmv.wire)
  const usv = await call(bookmarkRoute.DELETE, 'DELETE', `/api/session/${Pm}/wines/${wb.wire.id}/bookmark`, Bp, undefined, { code: Pm, wineId: wb.wire.id })
  check('unsave in the moment → { ok, saved: false }', usv.status === 200 && usv.wire.saved === false, usv.wire)
  await resetLimits()
  const se = await call(settingsRoute.PATCH, 'PATCH', `/api/session/${Pm}/settings`, Ap, { description: 'public ids' }, { code: Pm })
  check('settings echo: meta wire', se.status === 200 && se.wire.meta.hostUserId === Ap.pid && se.wire.meta.hostIdentityId === `u:${Ap.pid}`, se.wire)
  await resetLimits()
  const bpBan = await call(banPreviewRoute.GET, 'GET', `/api/session/${Pm}/bans/preview/${encodeURIComponent(`u:${Bp.pid}`)}`, Ap, undefined, { code: Pm, identityId: encodeURIComponent(`u:${Bp.pid}`) })
  check('ban preview echo: identityId wire', bpBan.status === 200 && bpBan.wire.identityId === `u:${Bp.pid}`, bpBan.wire)
  // A ban on someone never in the moment (Cq), and one on a nonexistent integer straight into Redis.
  await resetLimits()
  const banC = await call(bansRoute.POST, 'POST', `/api/session/${Pm}/bans`, Ap, { identityId: `u:${Cq.pid}`, mode: 'ban' }, { code: Pm })
  check('ban by u:<publicId> (a non-participant): 200, stored as the INTERNAL identity', banC.status === 200 && !!(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: Pm, identityId: `u:${Cq.id}` } } })), banC.wire)
  await redis.sAdd(k.bans(Pm), 'u:999999999')
  await resetLimits()
  const bl = await call(bansRoute.GET, 'GET', `/api/session/${Pm}/bans`, Ap, undefined, { code: Pm })
  check('bans list: wire ids; a ban whose users row is gone leaves the list', bl.status === 200 && (bl.wire.bans as { identityId: string }[]).some(b => b.identityId === `u:${Cq.pid}`) && (bl.wire.bans as { identityId: string }[]).every(b => isWireU(b.identityId) || b.identityId.startsWith('a:')), bl.wire)
  await redis.sAdd(k.bans(Pm), ['u:99999999999', 'u:0042'])
  await resetLimits()
  const stJ = await call(stateRoute.GET, 'GET', `/api/session/${Pm}/state`, Ap, undefined, { code: Pm })
  const blJ = await call(bansRoute.GET, 'GET', `/api/session/${Pm}/bans`, Ap, undefined, { code: Pm })
  const metaJ = stJ.wire.meta as { banCount?: number } | null
  check('🔒 junk ban members (beyond int4, a leading zero) never break the host\'s view; the count is what the list shows', stJ.status === 200 && !!metaJ && metaJ.banCount === (blJ.wire.bans as unknown[]).length, { banCount: metaJ?.banCount, listed: (blJ.wire.bans as unknown[] | undefined)?.length })
  await redis.sRem(k.bans(Pm), ['u:99999999999', 'u:0042'])
  const bansBefore = await prisma.sessionBan.count({ where: { sessionCode: Pm } })
  await resetLimits()
  const banU = await call(bansRoute.POST, 'POST', `/api/session/${Pm}/bans`, Ap, { identityId: `u:${UNKNOWN}`, mode: 'ban' }, { code: Pm })
  check('🔒 ban of an unknown public id: 200, the limiter charged, nothing written', banU.status === 200 && (await prisma.sessionBan.count({ where: { sessionCode: Pm } })) === bansBefore && Number(await redis.get(`rl:sessban:u:${Ap.id}:10m`)) === 1, banU.wire)
  await resetLimits()
  const rsC = await call(removedStateRoute.GET, 'GET', `/api/session/${Pm}/removed-state`, Cq, undefined, { code: Pm })
  check('removed-state: identityId wire', rsC.status === 200 && rsC.wire.state === 'banned' && rsC.wire.identityId === `u:${Cq.pid}`, rsC.wire)
  await resetLimits()
  const pvw = await call(previewRoute.GET, 'GET', `/api/session/${Pm}/preview`, Cq, undefined, { code: Pm })
  check('preview: banned → 403 (no ids)', pvw.status === 403)
  await resetLimits()
  const ms = await call(meSessionsRoute.GET, 'GET', '/api/me/sessions', Bp)
  const msRow = (ms.wire as unknown as { code: string; people: { id: string }[] }[]).find(x => x.code === Pm)
  check('/api/me/sessions: people[].id wire, no host_user_id', ms.status === 200 && !!msRow && msRow.people.some(p => p.id === `u:${Ap.pid}`) && msRow.people.every(p => isWireU(p.id)) && !('host_user_id' in msRow), msRow)
  await resetLimits()
  const msHost = await call(meSessionsRoute.GET, 'GET', `/api/me/sessions?tense=upcoming&hosts=${encodeURIComponent(`u:${Ap.pid}`)}`, Bp)
  const msInt = await call(meSessionsRoute.GET, 'GET', `/api/me/sessions?tense=upcoming&hosts=${encodeURIComponent(`u:${Ap.id}`)}`, Bp)
  const msUnk = await call(meSessionsRoute.GET, 'GET', `/api/me/sessions?tense=upcoming&hosts=${encodeURIComponent(`u:${UNKNOWN}`)}`, Bp)
  check('hosts=u:<publicId> filters to that host', (msHost.wire as unknown as { code: string }[]).some(x => x.code === Pm))
  check('🔒 hosts= with a malformed (integer) or unknown entry matches NOTHING (a FALSE clause, never a dropped filter)', (msInt.wire as unknown[]).length === 0 && (msUnk.wire as unknown[]).length === 0, { msInt: msInt.wire, msUnk: msUnk.wire })
  await resetLimits()
  const msPeople = await call(meSessionsRoute.GET, 'GET', `/api/me/sessions?people=${encodeURIComponent(`u:${Ap.id}`)}`, Bp)
  check('people=u:<int> matches nothing', (msPeople.wire as unknown[]).length === 0)

  // (2) Inputs: the fixture's integer gets the malformed answer on EVERY input route.
  const intP = String(Bp.id), intU = `u:${Bp.id}`
  const inputs: [string, () => Promise<{ status: number }>, number][] = [
    ['profile GET', () => call(usersRoute.GET, 'GET', `/api/users/${intP}`, Ap, undefined, { id: intP }), 400],
    ['badges GET', () => call(badgesRoute.GET, 'GET', `/api/users/${intP}/badges`, Ap, undefined, { id: intP }), 400],
    ['followers GET', () => call(followersRoute.GET, 'GET', `/api/users/${intP}/followers`, Ap, undefined, { id: intP }), 400],
    ['following GET', () => call(followingRoute.GET, 'GET', `/api/users/${intP}/following`, Ap, undefined, { id: intP }), 400],
    ['feed ?user=', () => call(feedRoute.GET, 'GET', `/api/feed?user=${intP}`, Ap), 400],
    ['follow POST', () => call(followRoute.POST, 'POST', `/api/users/${intP}/follow`, Cq, undefined, { id: intP }), 400],
    ['follow DELETE', () => call(followRoute.DELETE, 'DELETE', `/api/users/${intP}/follow`, Ap, undefined, { id: intP }), 400],
    ['block POST', () => call(blockRoute.POST, 'POST', `/api/me/blocks/${intP}`, Cq, undefined, { id: intP }), 400],
    ['block DELETE', () => call(blockRoute.DELETE, 'DELETE', `/api/me/blocks/${intP}`, Cq, undefined, { id: intP }), 400],
    ['mute POST', () => call(muteRoute.POST, 'POST', `/api/me/mutes/${intP}`, Cq, undefined, { id: intP }), 400],
    ['mute DELETE', () => call(muteRoute.DELETE, 'DELETE', `/api/me/mutes/${intP}`, Cq, undefined, { id: intP }), 400],
    ['set-role targetId', () => call(codeRoute.PATCH, 'PATCH', `/api/session/${Pm}`, Ap, { action: 'set-role', targetId: intU, role: 'co_host' }, { code: Pm }), 400],
    ['bans POST identityId', () => call(bansRoute.POST, 'POST', `/api/session/${Pm}/bans`, Ap, { identityId: intU, mode: 'kick' }, { code: Pm }), 400],
    ['unban', () => call(unbanRoute.DELETE, 'DELETE', `/api/session/${Pm}/bans/${encodeURIComponent(`u:${Cq.id}`)}`, Ap, undefined, { code: Pm, identityId: encodeURIComponent(`u:${Cq.id}`) }), 400],
    ['ban preview', () => call(banPreviewRoute.GET, 'GET', `/api/session/${Pm}/bans/preview/${encodeURIComponent(intU)}`, Ap, undefined, { code: Pm, identityId: encodeURIComponent(intU) }), 400],
    ['brought-by', () => call(wineRoute.PATCH, 'PATCH', `/api/session/${Pm}/wines/${wa.wire.id}`, Ap, { broughtByIdentityId: intU }, { code: Pm, wineId: wa.wire.id }), 400],
  ]
  for (const [label, run, want] of inputs) {
    await resetLimits()
    const r = await run()
    check(`🔒 ${label} with the fixture's integer → ${want} (malformed, never resolved)`, r.status === want, r)
  }
  check('…none of them wrote: Bp is no cohost, Cq still banned, no follow / block / mute of Bp by Cq', !(await prisma.sessionMember.findFirst({ where: { sessionCode: Pm, userId: Bp.id, role: 'co_host' } }))
    && !!(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: Pm, identityId: `u:${Cq.id}` } } }))
    && !(await prisma.follow.findFirst({ where: { followerId: Cq.id, followingId: Bp.id } }))
    && !(await prisma.userBlock.findFirst({ where: { blockerId: Cq.id, blockedId: Bp.id } }))
    && !(await prisma.userMute.findFirst({ where: { muterId: Cq.id, mutedId: Bp.id } })))

  // (3) The null paths: blocked-me and unknown answer identically, also with the limiter spent.
  const Ep = await mkUser('Eve Blocks')
  await prisma.userBlock.create({ data: { blockerId: Ep.id, blockedId: Ap.id } })
  const same = (a: { status: number; wire: unknown }, b: { status: number; wire: unknown }) => a.status === b.status && JSON.stringify(a.wire) === JSON.stringify(b.wire)
  await resetLimits()
  let ra = await call(usersRoute.GET, 'GET', `/api/users/${Ep.pid}`, Ap, undefined, { id: Ep.pid })
  let rb = await call(usersRoute.GET, 'GET', `/api/users/${UNKNOWN}`, Ap, undefined, { id: UNKNOWN })
  check('🔒 profile: blocked-me and unknown → the same 404', ra.status === 404 && same(ra, rb), { ra: ra.wire, rb: rb.wire })
  await redis.set(`rl:profile:unknown:1m`, '60', { EX: 60 })
  ra = await call(usersRoute.GET, 'GET', `/api/users/${Ep.pid}`, Ap, undefined, { id: Ep.pid })
  rb = await call(usersRoute.GET, 'GET', `/api/users/${UNKNOWN}`, Ap, undefined, { id: UNKNOWN })
  check('…and with the limiter spent: the same 429 (the lookup never runs before it)', ra.status === 429 && same(ra, rb), { ra: ra.status, rb: rb.status })
  for (const [label, route, method] of [['follow', followRoute, 'POST'], ['block', blockRoute, 'POST'], ['mute', muteRoute, 'POST'], ['mute', muteRoute, 'DELETE'], ['follow', followRoute, 'DELETE'], ['block', blockRoute, 'DELETE']] as const) {
    await resetLimits()
    const path = label === 'follow' ? `/api/users/{id}/follow` : `/api/me/${label}s/{id}`
    const h = (route as Record<string, unknown>)[method]
    ra = await call(h, method, path.replace('{id}', Ep.pid), Ap, undefined, { id: Ep.pid })
    rb = await call(h, method, path.replace('{id}', UNKNOWN), Ap, undefined, { id: UNKNOWN })
    check(`🔒 ${label} ${method}: blocked-me and unknown → the same answer`, ra.status === rb.status && same(ra, rb), { ra: ra.wire, rb: rb.wire })
  }
  await resetLimits()
  await call(muteRoute.DELETE, 'DELETE', `/api/me/mutes/${UNKNOWN}`, Ap, undefined, { id: UNKNOWN })
  check('🔒 mute DELETE of an unknown id charges the limiter like a real target', Number(await redis.get(`rl:mute:u:${Ap.id}:1h`)) === 1)
  await redis.set(`rl:follow:${Ap.id}:1h`, '60', { EX: 3600 })
  ra = await call(followRoute.POST, 'POST', `/api/users/${Ep.pid}/follow`, Ap, undefined, { id: Ep.pid })
  rb = await call(followRoute.POST, 'POST', `/api/users/${UNKNOWN}/follow`, Ap, undefined, { id: UNKNOWN })
  check('🔒 follow with the limiter spent: blocked-me and unknown both 429', ra.status === 429 && same(ra, rb))
  await resetLimits()
  ra = await call(codeRoute.PATCH, 'PATCH', `/api/session/${Pm}`, Ap, { action: 'set-role', targetId: `u:${Ep.pid}`, role: 'provider' }, { code: Pm })
  rb = await call(codeRoute.PATCH, 'PATCH', `/api/session/${Pm}`, Ap, { action: 'set-role', targetId: `u:${UNKNOWN}`, role: 'provider' }, { code: Pm })
  check('set-role: a non-member and an unknown id → the same 400', ra.status === 400 && same(ra, rb), { ra: ra.wire, rb: rb.wire })
  await resetLimits()
  ra = await call(banPreviewRoute.GET, 'GET', `/api/session/${Pm}/bans/preview/${encodeURIComponent(`u:${UNKNOWN}`)}`, Ap, undefined, { code: Pm, identityId: encodeURIComponent(`u:${UNKNOWN}`) })
  check('ban preview of an unknown id → 404', ra.status === 404)
  await resetLimits()
  ra = await call(unbanRoute.DELETE, 'DELETE', `/api/session/${Pm}/bans/${encodeURIComponent(`u:${UNKNOWN}`)}`, Ap, undefined, { code: Pm, identityId: encodeURIComponent(`u:${UNKNOWN}`) })
  check('🔒 unban of an unknown id → 200 and the limiter charged', ra.status === 200 && Number(await redis.get(`rl:sessban:u:${Ap.id}:10m`)) === 1)
  await resetLimits()
  ra = await call(wineRoute.PATCH, 'PATCH', `/api/session/${Pm}/wines/${wa.wire.id}`, Ap, { broughtByIdentityId: `u:${UNKNOWN}` }, { code: Pm, wineId: wa.wire.id })
  check('brought-by an unknown id → "not in this moment"', ra.status === 400 && /not in this moment/.test(String(ra.wire.error)), ra.wire)

  // (4) A deleted participant before the d: migration (a best-effort projection).
  const Dp = await mkUser('Dora Deleted')
  await resetLimits()
  await call(joinRoute.POST, 'POST', '/api/session/join', Dp, { code: Pm, displayName: 'Dora' })
  await resetLimits()
  let st2 = await call(stateRoute.GET, 'GET', `/api/session/${Pm}/state`, Ap, undefined, { code: Pm })
  check('setup: the participant renders once (the forward cache now holds them)', (st2.wire.meta.participants as { id: string }[]).some(p => p.id === `u:${Dp.pid}`))
  await prisma.$executeRaw`DELETE FROM users WHERE id = ${Dp.id}`
  check('…their u:<int> still lingers in Redis (the projection never ran)', !!(await redis.hGet(k.identities(Pm), `u:${Dp.id}`)))
  publicIds._resetPublicIdCache() // the 10-minute entry window passing
  await resetLimits()
  st2 = await call(stateRoute.GET, 'GET', `/api/session/${Pm}/state`, Ap, undefined, { code: Pm })
  check('🔒 after the window: the lingering entry is DROPPED, never its integer (canary)', st2.status === 200 && !(st2.wire.meta.participants as { id: string }[]).some(p => p.id === `u:${Dp.pid}`) && !JSON.stringify(st2.wire).includes(String(Dp.id)), st2.wire.meta.participants)

  // (5) The people cursor: sealed, bound to its list.
  const Wo = await mkBare(`Wren Owner ${TAG}`)
  const WoPid = await pidOf(Wo)
  const fans: number[] = []
  for (let i = 0; i < 35; i++) fans.push(await mkBare(`Fan ${i} ${TAG}`))
  const t0 = Date.now() - 3600_000
  // Distinct follow times: fan i followed at t0 + i seconds (newest = fan 34).
  await prisma.follow.createMany({ data: fans.map((f, i) => ({ followerId: f, followingId: Wo, createdAt: new Date(t0 + i * 1000) })) })
  await prisma.follow.create({ data: { followerId: Ap.id, followingId: Wo } })
  await resetLimits()
  const listPage = async (v: User, id: string, dir: 'followers' | 'following', qs = '') => { await resetLimits(); return call(dir === 'followers' ? followersRoute.GET : followingRoute.GET, 'GET', `/api/users/${id}/${dir}${qs}`, v, undefined, { id }) }
  const p1 = await listPage(Bp, WoPid, 'followers')
  const fanPids = await Promise.all(fans.map(pidOf))
  const apFirst = (p1.wire.users as { id: string }[])[0]?.id === Ap.pid
  const order1 = (p1.wire.users as { id: string }[]).map(u => u.id)
  check('people order: newest follow first (Ap followed last, then fan 34, 33, …)', apFirst && order1.slice(1, 4).join() === [fanPids[34], fanPids[33], fanPids[32]].join(), order1.slice(0, 4))
  check('…the cursor is opaque: no time, no id in it', typeof p1.wire.nextCursor === 'string' && !/\d{10}/.test(p1.wire.nextCursor) && !p1.wire.nextCursor.includes(WoPid))
  // An unfollow between pages, of the very row the cursor was cut at: the
  // keyset is value-based (no edge lookup), so the next page still follows.
  check('setup: page 1 ends at fan 6', order1.length === 30 && order1[29] === fanPids[6], order1.slice(-2))
  await prisma.follow.deleteMany({ where: { followerId: fans[6], followingId: Wo } })
  const p2 = await listPage(Bp, WoPid, 'followers', `?cursor=${encodeURIComponent(p1.wire.nextCursor)}`)
  const order2 = (p2.wire.users as { id: string }[]).map(u => u.id)
  const all = [...order1, ...order2]
  check('paging across an unfollow of the cursor row: page 2 = fans 5 … 0, no repeat, no skip', order2.join() === fanPids.slice(0, 6).reverse().join() && new Set(all).size === all.length && p2.wire.nextCursor === null, { order2 })
  const tampered = p1.wire.nextCursor.slice(0, -2) + (p1.wire.nextCursor.endsWith('A') ? 'BB' : 'AA')
  const pt = await listPage(Bp, WoPid, 'followers', `?cursor=${encodeURIComponent(tampered)}`)
  check('🔒 a tampered cursor → an empty page', pt.status === 200 && pt.wire.users.length === 0 && pt.wire.nextCursor === null, pt.wire)
  const pOther = await listPage(Cq, WoPid, 'followers', `?cursor=${encodeURIComponent(p1.wire.nextCursor)}`)
  check('🔒 a cursor replayed by another VIEWER → empty', pOther.wire.users.length === 0)
  const pTab = await listPage(Bp, WoPid, 'following', `?cursor=${encodeURIComponent(p1.wire.nextCursor)}`)
  const pList = await listPage(Bp, Ap.pid, 'followers', `?cursor=${encodeURIComponent(p1.wire.nextCursor)}`)
  const pFilter = await listPage(Bp, WoPid, 'followers', `?mutual=non&cursor=${encodeURIComponent(p1.wire.nextCursor)}`)
  check('🔒 …onto another tab, another list, another filter → empty', pTab.wire.users.length === 0 && pList.wire.users.length === 0 && pFilter.wire.users.length === 0)
  // Following + Friends order, and rows sharing one timestamp.
  await prisma.follow.createMany({ data: fans.slice(0, 3).map((f, i) => ({ followerId: Wo, followingId: f, createdAt: new Date(t0 + (10 - i) * 1000) })) })
  const fo = await listPage(Bp, WoPid, 'following')
  check('Following: by when the owner followed them (fan 0 newest)', (fo.wire.users as { id: string }[]).map(u => u.id).join() === [fanPids[0], fanPids[1], fanPids[2]].join(), fo.wire.users)
  const fr = await listPage(Bp, WoPid, 'followers', '?mutual=mutual')
  check('Friends: by when the person followed the owner (fan 2 followed after 1 after 0)', (fr.wire.users as { id: string }[]).map(u => u.id).join() === [fanPids[2], fanPids[1], fanPids[0]].join(), fr.wire.users)
  const Wt = await mkBare(`Wren Tie ${TAG}`)
  await prisma.$executeRaw`INSERT INTO follows (follower_id, following_id) SELECT f, ${Wt} FROM unnest(${fans}::int[]) AS f`
  const tie1 = await listPage(Bp, await pidOf(Wt), 'followers')
  const tie2 = await listPage(Bp, await pidOf(Wt), 'followers', `?cursor=${encodeURIComponent(tie1.wire.nextCursor)}`)
  const tieAll = [...tie1.wire.users, ...tie2.wire.users].map((u: { id: string }) => u.id)
  check('rows sharing ONE timestamp (one INSERT … SELECT): 30 + 5, no repeat, tie-break public_id', tie1.wire.users.length === 30 && tieAll.length === 35 && new Set(tieAll).size === 35 && tieAll.join() === [...tieAll].sort().reverse().join(), { n1: tie1.wire.users.length, n2: tie2.wire.users.length })

  // (6) Auth through the route MODULE (the wrapper rewrites the body).
  const baBase = (await betterAuthServer.$context).baseURL
  const baOrigin = new URL(baBase).origin
  const ba = async (method: 'GET' | 'POST', path: string, body?: unknown, cookie?: string) => {
    await resetLimits()
    const baLimits = await scanKeys('*|/*') // Better Auth's own limiter keys (`<ip>|<path>`)
    if (baLimits.length) await redis.del(baLimits)
    const res = await (method === 'GET' ? nativeAuthRoute.GET : nativeAuthRoute.POST)(new NextRequest(`${baBase}${path}`, { method, headers: { 'content-type': 'application/json', origin: baOrigin, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }))
    const text = await res.text()
    await canary(`BA ${path}`, text, res.headers)
    let json: any = null // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    return { status: res.status, headers: res.headers, json }
  }
  // Sign-up answers HONESTLY and in ONE step since usernames (§ 9): the fake
  // success for a taken email is gone (the conflict answers, a held name and
  // the rest of the sign-up matrix: § 21, usernames-section.mts).
  const freeEmail = `${TAG}-free@example.test`
  const freeName = fixtureUsername('free')
  const suFree = await ba('POST', '/sign-up/email', { name: 'Fran Free', email: freeEmail, password: 'pw-free-12345', username: freeName.toUpperCase() })
  const freeRow = await prisma.user.findUnique({ where: { email: freeEmail }, select: { id: true, publicId: true, username: true } })
  const suCookie = (suFree.headers.get('set-cookie') ?? '').split(';')[0]
  check('sign-up (free): user.id is the new account\'s public id, the canonical username, no image', suFree.status === 200 && suFree.json.user.id === freeRow?.publicId && suFree.json.user.username === freeName && freeRow?.username === freeName && !('image' in suFree.json.user), suFree.json)
  check('🔒 sign-up is ONE step: a token, a session cookie, exactly one device row', typeof suFree.json.token === 'string' && suCookie.startsWith('better-auth.session_token=') && (await prisma.authSession.count({ where: { userId: freeRow!.id } })) === 1, { token: suFree.json.token, suCookie: suCookie.slice(0, 30) })
  const suTaken = await ba('POST', '/sign-up/email', { name: 'Fran Free', email: Ap.email, password: 'pw-free-12345', username: fixtureUsername('free') })
  check('🔒 a taken email answers honestly: 422 EMAIL_TAKEN, no token, no cookie, no user object', suTaken.status === 422 && suTaken.json.code === 'EMAIL_TAKEN' && !('user' in suTaken.json) && !('token' in suTaken.json) && !suTaken.headers.get('set-cookie'), suTaken.json)
  const badEmail = `${TAG}-bad@example.test`
  const badFree = await ba('POST', '/sign-up/email', { name: 'x', email: badEmail, password: 'pw-free-12345', username: fixtureUsername('free') })
  check('an invalid name → 400 INVALID_NAME, nothing created', badFree.status === 400 && badFree.json.code === 'INVALID_NAME' && !(await prisma.user.findUnique({ where: { email: badEmail } })), badFree.json)
  const pidFree = await ba('POST', '/sign-up/email', { name: 'Pia Pick', email: `${TAG}-pick@example.test`, password: 'pw-free-12345', username: fixtureUsername('free'), publicId: 'AAAAAAAAAAAA' })
  check('🔒 a sign-up body carrying publicId → 400 for a free email, nothing created', pidFree.status === 400 && !(await prisma.user.findUnique({ where: { email: `${TAG}-pick@example.test` } })), pidFree.json)
  // The sign-up's own session is retired through Better Auth: the checks below
  // are about a session a SIGN-IN created.
  await (await betterAuthServer.$context).internalAdapter.deleteSession(suFree.json.token)
  const si = await ba('POST', '/sign-in/email', { email: freeEmail, password: 'pw-free-12345' })
  const siCookie = (si.headers.get('set-cookie') ?? '').split(';')[0]
  check('sign-in: user.id public, no image, a session cookie', si.status === 200 && si.json.user.id === freeRow?.publicId && !('image' in si.json.user) && siCookie.startsWith('better-auth.session_token='), si.json)
  const tok = decodeURIComponent(siCookie.split('=')[1] ?? '').split('.')[0]
  const adapter = (await betterAuthServer.$context).internalAdapter
  await adapter.updateSession(tok, { expiresAt: new Date(Date.now() + (365 - 2) * 86400_000) })
  const gs = await ba('GET', '/get-session', undefined, siCookie)
  check('get-session past updateAge: Set-Cookie KEPT, user.id + session.userId public, no image', gs.status === 200 && (gs.headers.get('set-cookie') ?? '').includes('better-auth.session_token=') && gs.json.user.id === freeRow?.publicId && gs.json.session.userId === freeRow?.publicId && !('image' in gs.json.user), { status: gs.status, user: gs.json?.user, sc: gs.headers.get('set-cookie')?.slice(0, 30) })
  await redis.del(tok) // a Redis copy written before the deploy lacks publicId: the wrapper looks it up
  const gs2 = await ba('GET', '/get-session', undefined, siCookie)
  check('get-session served from Postgres (no copy): still the public id', gs2.status === 200 && gs2.json.user.id === freeRow?.publicId)
  const la = await ba('GET', '/list-accounts', undefined, siCookie)
  check('🔒 /list-accounts is disabled (404)', la.status === 404, la)

  // (7) Schema invariants Prisma can't see.
  const sqlErr = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => String(e))
  const [raw] = await prisma.$queryRaw<{ public_id: string }[]>`INSERT INTO users (name, email, public_id) VALUES ('Raw Insert', ${`${TAG}-raw@example.test`}, 'AAAAAAAAAAAA') RETURNING public_id`
  check('🔒 the insert trigger overrides a supplied public_id', isPid(raw.public_id) && raw.public_id !== 'AAAAAAAAAAAA', raw)
  check('🔒 the update trigger rejects a change', /immutable/.test((await sqlErr(prisma.$executeRaw`UPDATE users SET public_id = 'BBBBBBBBBBBB' WHERE email = ${`${TAG}-raw@example.test`}`)) ?? ''))
  check('…an unrelated update still works', (await prisma.$executeRaw`UPDATE users SET xp = xp + 1 WHERE email = ${`${TAG}-raw@example.test`}`) === 1)
  const chk = await sqlErr(prisma.$transaction(async tx => {
    await tx.$executeRaw`ALTER TABLE users DISABLE TRIGGER users_public_id_mint`
    await tx.$executeRaw`INSERT INTO users (name, email, public_id) VALUES ('Bad', ${`${TAG}-badfmt@example.test`}, '1AAAAAAAAAAA')`
  }))
  check('🔒 the format CHECK refuses a digit-first id (trigger off, rolled back)', /users_public_id_format_chk/.test(chk ?? ''), chk)
  check('🔒 session_bans refuses a wire identity (u:<publicId>)', /session_bans_identity_id_chk/.test((await sqlErr(prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${Pm}, ${`u:${Ap.pid}`})`)) ?? ''))
  check('🔒 wines.added_by_identity_id refuses a wire identity', /wines_added_by_identity_id_chk/.test((await sqlErr(prisma.$executeRaw`UPDATE wines SET added_by_identity_id = ${`u:${Ap.pid}`} WHERE id = ${wa.wire.id}`)) ?? ''))
  const conc = await Promise.all(Array.from({ length: 25 }, (_, i) => prisma.$queryRaw<{ public_id: string }[]>`INSERT INTO users (name, email) VALUES ('Conc', ${`${TAG}-conc-${i}@example.test`}) RETURNING public_id`))
  check('concurrent signups: distinct, well-formed public ids', new Set(conc.map(r => r[0].public_id)).size === 25 && conc.every(r => isPid(r[0].public_id)))
  await prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${`${TAG}-conc-%`} OR email = ${`${TAG}-raw@example.test`}`

  // (8) Redis: nothing stored a wire identity (a missed inbound translation would).
  const leaked: string[] = []
  for (const key of await scanKeys(`s:${Pm}:*`)) {
    const t = await redis.type(key)
    const vals = t === 'string' ? [await redis.get(key)] : t === 'hash' ? Object.entries(await redis.hGetAll(key)).flat() : t === 'set' ? await redis.sMembers(key) : []
    for (const v of [key, ...vals]) if (v && /u:[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}/.test(v)) leaked.push(key)
  }
  check('🔒 no Redis key or value of the moment holds u:<publicId>', leaked.length === 0, leaked)

  // (9) Images: tile ownership is the row, never the key.
  const Tw = await mkUser('Tom Tiles')
  const Mo = await createSession(Tw, 'Tom night')
  const tw1 = await addWine(Mo, Tw, 'Tom Bottle')
  await rate(Mo, Tw, tw1.id)
  await resetLimits()
  const up1 = await call(tilesRoute.POST, 'POST', '/api/me/profile/tiles/impressions', Tw, { imageData: PNG }, { tile: 'impressions' })
  const ownA = up1.json.tiles.impressions.imageUrl as string
  await prisma.$executeRaw`UPDATE users SET tile_impressions_url = ${tw1.url} WHERE id = ${Tw.id}`
  check('🔒 a raw url update (an old writer) makes the tile not own: the pin is a reference', !(await prisma.user.findUniqueOrThrow({ where: { id: Tw.id }, select: { tileImpressionsUrl: true, tileImpressionsOwnUrl: true } }).then(r => r.tileImpressionsUrl === r.tileImpressionsOwnUrl)))
  await resetLimits()
  await call(tilesRoute.POST, 'POST', '/api/me/profile/tiles/impressions', Tw, { imageData: PNG }, { tile: 'impressions' })
  check('…and the replace over it reclaims nothing that is referenced (the wine photo stays)', store.has(keyOf(tw1.url)))
  const Ox = await mkUser('Oz Other')
  await resetLimits()
  const oxUp = await call(tilesRoute.POST, 'POST', '/api/me/profile/tiles/impressions', Ox, { imageData: PNG }, { tile: 'impressions' })
  const oxUrl = oxUp.json.tiles.impressions.imageUrl as string
  const pinOther = await patchProfile(Tw, { tiles: { impressions: oxUrl } })
  check('🔒 a body pin of another user\'s tile URL is refused (not in the pool)', pinOther.status === 400)
  await prisma.$executeRaw`UPDATE users SET tile_impressions_url = ${oxUrl} WHERE id = ${Tw.id}`
  await resetLimits()
  await call(tilesRoute.POST, 'POST', '/api/me/profile/tiles/impressions', Tw, { imageData: PNG }, { tile: 'impressions' })
  check('🔒 …even stored by a raw write, it is never own: the replace reclaims nothing of theirs', store.has(keyOf(oxUrl)))
  void ownA

  // (10) The blocks list carries no photo (D5).
  await resetLimits()
  await call(blockRoute.POST, 'POST', `/api/me/blocks/${Cq.pid}`, Ap, undefined, { id: Cq.pid })
  await prisma.user.update({ where: { id: Cq.id }, data: { imageUrl: 'https://img.test/cq.jpg' } })
  const blk = await call(blocksListRoute.GET, 'GET', '/api/me/blocks', Ap)
  check('🔒 blocks list: public ids, no imageUrl', blk.status === 200 && (blk.wire.blocks as Record<string, unknown>[]).every(b => isPid(b.id) && !('imageUrl' in b)) && (blk.wire.blocks as { id: string }[]).some(b => b.id === Cq.pid), blk.wire)
  await prisma.userBlock.deleteMany({ where: { blockerId: Ap.id, blockedId: Cq.id } })

  // (11) The bans list photo is judged for the CALLER (§ 8a b).
  const Np = await mkUser('Nia Banned')
  await prisma.user.update({ where: { id: Np.id }, data: { imageUrl: 'https://img.test/np.jpg', profileVisibility: 'public-mutual' } })
  await resetLimits()
  await call(bansRoute.POST, 'POST', `/api/session/${Pm}/bans`, Ap, { identityId: `u:${Np.pid}`, mode: 'ban' }, { code: Pm })
  const npPhoto = async (u: Actor) => { await resetLimits(); const r = await call(bansRoute.GET, 'GET', `/api/session/${Pm}/bans`, u, undefined, { code: Pm }); return (r.wire.bans as { identityId: string; imageUrl: string | null }[] | undefined)?.find(b => b.identityId === `u:${Np.pid}`) }
  check('🔒 bans list, logged-in host: a Friends-only stranger\'s photo is hidden', (await npPhoto(Ap))?.imageUrl === null)
  await prisma.follow.createMany({ data: [{ followerId: Ap.id, followingId: Np.id }, { followerId: Np.id, followingId: Ap.id }] })
  check('…shown once the host is their friend', (await npPhoto(Ap))?.imageUrl === 'https://img.test/np.jpg')
  await resetLimits()
  await call(codeRoute.PATCH, 'PATCH', `/api/session/${Pm}`, Ap, { action: 'set-role', targetId: `u:${Bp.pid}`, role: 'co_host' }, { code: Pm })
  check('🔒 …but the COHOST (no friend of theirs) reading the same list still gets null (the caller is the viewer)', (await npPhoto(Bp))?.imageUrl === null)
  await resetLimits()
  const anonM = await call(sessionRoute.POST, 'POST', '/api/session', {}, { hostDisplayName: 'Anon Host', sessionName: `${TAG} anon`, dateFrom })
  const anonA: Actor = { anon: anonM.wire.anonToken }
  await resetLimits()
  await call(bansRoute.POST, 'POST', `/api/session/${anonM.wire.code}/bans`, anonA, { identityId: `u:${Np.pid}`, mode: 'ban' }, { code: anonM.wire.code })
  const anonPhoto = async () => { await resetLimits(); const r = await call(bansRoute.GET, 'GET', `/api/session/${anonM.wire.code}/bans`, anonA, undefined, { code: anonM.wire.code }); return (r.wire.bans as { identityId: string; imageUrl: string | null }[]).find(b => b.identityId === `u:${Np.pid}`) }
  check('🔒 an anonymous host: the logged-out rule (Friends-only → null)', (await anonPhoto())?.imageUrl === null)
  await prisma.user.update({ where: { id: Np.id }, data: { profileVisibility: 'public-internet' } })
  check('…a public-internet photo shows', (await anonPhoto())?.imageUrl === 'https://img.test/np.jpg')

  // (12) The re-key script on a fixture.
  const Rk = await mkUser('Rex Rekey')
  const legacy = {
    avatar: `avatars/u_${Rk.id}_1_aa.png`, cover: `avatars/cover_u_${Rk.id}_1_bb.png`,
    tile: `avatars/tile_impressions_u_${Rk.id}_1_cc.png`, ci: `wines/ci_${Rk.id}_1_dd.png`, orphan: `avatars/u_${Rk.id}_9_zz.png`,
  }
  for (const key of Object.values(legacy)) store.add(key)
  // The tile is an OVERLAP-era own upload: own_url stale (NULL), the legacy key its owner's.
  await prisma.$executeRaw`UPDATE users SET image_url = ${urlOf(legacy.avatar)}, cover_photo_url = ${urlOf(legacy.cover)}, tile_impressions_url = ${urlOf(legacy.tile)}, tile_impressions_own_url = NULL WHERE id = ${Rk.id}`
  const ciW = await prisma.wine.create({ data: { id: `rk${Date.now()}`.slice(0, 21), name: 'Rekey', imageUrl: urlOf(legacy.ci) }, select: { id: true } })
  const { S3Client } = await import('@aws-sdk/client-s3')
  const s3 = new S3Client({ endpoint: S3, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } })
  const { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const manifest = pjoin(mkdtempSync(pjoin(tmpdir(), 'rekey-')), 'manifest.jsonl')
  const logs: Record<string, unknown>[] = []
  const putsBefore = puts.length
  const dry = await rekey.run({ mode: 'dry', manifest, prisma, s3, bucket: 'verre', log: o => logs.push(o) }) as Record<string, number>
  check('re-key dry run: counts, writes nothing (no manifest, no copy, rows unchanged)', dry.objects >= 5 && dry.orphans >= 1 && dry.overlapEraOwnTiles >= 1 && !existsSync(manifest) && puts.length === putsBefore && (await prisma.user.findUniqueOrThrow({ where: { id: Rk.id }, select: { imageUrl: true } })).imageUrl === urlOf(legacy.avatar), dry)
  // Apply, racing a fresh avatar replace for Rk.
  const [, fresh] = await Promise.all([
    rekey.run({ mode: 'apply', manifest, prisma, s3, bucket: 'verre', log: o => logs.push(o) }),
    replaceProfileImage(Rk.id, 'avatar', PNG),
  ])
  const after = await prisma.user.findUniqueOrThrow({ where: { id: Rk.id }, select: { imageUrl: true, coverPhotoUrl: true, tileImpressionsUrl: true, tileImpressionsOwnUrl: true } })
  check('🔒 apply under a concurrent replace keeps the FRESH photo', fresh.ok && after.imageUrl === fresh.url && store.has(keyOf(fresh.url)), { after, fresh })
  const noPerson = (u: string | null) => !!u && !u.includes(String(Rk.id)) && !u.includes(Rk.pid)
  check('the cover, the tile and the check-in photo moved to keys with nothing of the person', noPerson(after.coverPhotoUrl) && noPerson(after.tileImpressionsUrl) && noPerson((await prisma.wine.findUniqueOrThrow({ where: { id: ciW.id }, select: { imageUrl: true } })).imageUrl), after)
  check('🔒 the overlap-era own tile stays OWN (own_url follows the url)', after.tileImpressionsUrl === after.tileImpressionsOwnUrl && store.has(keyOf(after.tileImpressionsUrl)), after)
  const lines = readFileSync(manifest, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { old: string; new: string | null })
  check('the manifest records every pair (the orphan with no copy)', lines.some(l => l.old === legacy.cover && !!l.new) && lines.some(l => l.old === legacy.orphan && l.new === null))
  check('🔒 the manifest is owner-only (0600), and its lock is gone after the run', (statSync(manifest).mode & 0o777) === 0o600 && !existsSync(`${manifest}.lock`), (statSync(manifest).mode & 0o777).toString(8))
  writeFileSync(`${manifest}.lock`, '1')
  let lockRefused = false
  try { await rekey.run({ mode: 'reclaim', manifest, prisma, s3, bucket: 'verre', log: () => {} }) } catch (e) { lockRefused = /another --apply/.test(String(e)) }
  unlinkSync(`${manifest}.lock`)
  check('🔒 a second apply / reclaim on the same manifest is refused while the lock is held', lockRefused)
  check('…the old objects remain until --reclaim (the way back)', store.has(legacy.cover) && store.has(legacy.tile))
  const rc = await rekey.run({ mode: 'reclaim', manifest, prisma, s3, bucket: 'verre', log: o => logs.push(o) }) as Record<string, number>
  check('--reclaim: unreferenced old objects + the orphan go, referenced new ones stay', !store.has(legacy.cover) && !store.has(legacy.tile) && !store.has(legacy.ci) && !store.has(legacy.orphan) && store.has(keyOf(after.coverPhotoUrl)) && store.has(keyOf(after.tileImpressionsUrl)) && rc.deleted >= 4, rc)
  const avatarPair = lines.find(l => l.old === legacy.avatar)
  check('…a copy that lost its race (the avatar replaced meanwhile) is reclaimed too', !!avatarPair?.new && !store.has(avatarPair.new) && store.has(keyOf(fresh.url)))
  await prisma.wine.delete({ where: { id: ciW.id } })
  }

  // ── § 19 the profile lists (lists plan § Verification) ─────────────────────
  {
  section('§ 19 the profile lists: the D4 rule, the lists, the tile counts, the feed, the writes')
  type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
  // The D4 state matrix (the SQL rule + SAFE_PHOTO against the plan's oracle).
  const mx = await Promise.all(['Mx Host', 'Mx Adder', 'Mx Stranger', 'Mx Cohost', 'Mx Kicked', 'Mx Banned', 'Mx Taster'].map(n => mkUser(n)))
  await outsideViewMatrix(prisma as never, check, { host: mx[0].id, adder: mx[1].id, stranger: mx[2].id, cohost: mx[3].id, kickedCohost: mx[4].id, bannedCohost: mx[5].id, taster: mx[6].id }, TAG)

  const Oo = await mkUser('Odile Owner')
  const Vv = await mkUser('Vera Viewer')
  const Hx = await mkUser('Hugo Host')
  const Ff = await mkUser('Fritz Friend')
  const Nn = await mkUser('Nina Nonfriend')
  await prisma.follow.createMany({ data: [
    { followerId: Vv.id, followingId: Oo.id }, { followerId: Oo.id, followingId: Vv.id },
    { followerId: Vv.id, followingId: Ff.id }, { followerId: Ff.id, followingId: Vv.id },
  ] })
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()
  const createWith = async (u: User | Actor, body: Record<string, unknown>) => {
    await resetLimits()
    const r = await call(sessionRoute.POST, 'POST', '/api/session', u, { hostDisplayName: 'Hana Host', sessionName: `${TAG} m`, dateFrom, ...body })
    if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
    return { code: r.json.code as string, anon: r.wire.anonToken as string | undefined }
  }
  const addW = async (code: string, u: User | Actor, name: string) => {
    await resetLimits()
    const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, u, { id: nanoid(), name, type: 'red' }, { code })
    if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
    return r.json.id as string
  }
  const rateS = async (code: string, u: User | Actor, wineId: string, score: number) => {
    await resetLimits()
    return call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, u, { wineId, score, flavors: {}, notes: 'n' }, { code })
  }
  const crave = async (code: string, u: User, wineId: string) => { await resetLimits(); return call(bookmarkRoute.POST, 'POST', `/api/session/${code}/wines/${wineId}/bookmark`, u, undefined, { code, wineId }) }
  const list = async (kind: 'impressions' | 'moments' | 'cravings', owner: User, viewer: User | Actor, q = '') => {
    await resetLimits()
    const route = kind === 'impressions' ? impressionsRoute : kind === 'moments' ? momentsListRoute : cravingsRoute
    return call(route.GET, 'GET', `/api/users/${owner.pid}/${kind}${q ? `?${q}` : ''}`, viewer, undefined, { id: owner.pid })
  }
  const tiles = async (owner: User, viewer: User) => (await getProfile(owner.id, viewer)).tiles as Record<string, { count: number }>
  const postOf = async (userId: number, code: string) => (await prisma.$queryRaw<{ id: number }[]>`
    SELECT fi.id FROM feed_items fi JOIN sessions s ON s.id = fi.session_id WHERE fi.user_id = ${userId} AND s.code = ${code}`)[0]?.id

  // ── the hidden-line-up write refusal (the LIVE rule, inside the contract) ──
  const HL = await createWith(Hx, { sessionName: `${TAG} hidden`, dateFrom: inDays(2), hideLineup: true, hideLineupMinutesBefore: 30 })
  const hw = await addW(HL.code, Hx, `${TAG} Hidden Bottle`)
  await join(HL.code, Vv)
  const vRate = await rateS(HL.code, Vv, hw, 4)
  const vCrave = await crave(HL.code, Vv, hw)
  check('🔒 a taster rating a bottle of a hidden line-up → the same 404 "wine not found"', vRate.status === 404 && vRate.json.error === 'wine not found', vRate)
  check('🔒 …and Crave → the same 404, nothing written', vCrave.status === 404 && (await prisma.bookmark.count({ where: { userId: Vv.id, wineId: hw } })) === 0, vCrave)
  check('the strict host still pre-rates and craves it', (await rateS(HL.code, Hx, hw, 4)).status === 200 && (await crave(HL.code, Hx, hw)).status === 200)
  const AN = await createWith({}, { sessionName: `${TAG} anon hidden`, dateFrom: inDays(2), hideLineup: true })
  const anonHost: Actor = { anon: AN.anon }
  const aw = await addW(AN.code, anonHost, 'Anon Bottle')
  check('an ANONYMOUS host of a Redis-only moment keeps pre-rating (isHostByIdentity)', (await rateS(AN.code, anonHost, aw, 4)).status === 200)

  // ── fixture: Odile's impressions ──
  await resetLimits()
  const ci0 = await call(checkinsRoute.POST, 'POST', '/api/checkins', Oo, { occurrenceId: nanoid(), wineName: `${TAG} Solo`, score: 3, flavors: {} })
  if (ci0.status !== 201) throw new Error(`check-in ${ci0.status}`)
  const soloPost = ci0.json.id as number
  const soloWine = (await prisma.$queryRaw<{ wine_id: string }[]>`SELECT r.wine_id FROM ratings r JOIN feed_items fi ON fi.rating_id = r.id WHERE fi.id = ${soloPost}`)[0].wine_id
  const M1 = await createWith(Hx, { sessionName: `${TAG} Jura evening` })
  const wa = await addW(M1.code, Hx, `${TAG} Alpha`)
  const wb = await addW(M1.code, Hx, `${TAG} Beta`)
  const we = await addW(M1.code, Hx, `${TAG} Epsilon`)
  await join(M1.code, Oo); await join(M1.code, Vv); await join(M1.code, Ff)
  await rateS(M1.code, Oo, wa, 3.5)
  await sleep(5)
  await rateS(M1.code, Oo, wb, 4.5)
  await sleep(5)
  await rateS(M1.code, Oo, wa, 3.5) // a re-rate moves rated_at, never had_at
  await rateS(M1.code, Vv, wa, 2.75)
  const M2 = await createWith(Hx, { sessionName: `${TAG} Blind night` })
  const wc = await addW(M2.code, Hx, `${TAG} Gamma`)
  await join(M2.code, Oo); await join(M2.code, Vv); await join(M2.code, Nn)
  await rateS(M2.code, Oo, wc, 4)
  await rateS(M2.code, Vv, wc, 4)
  await prisma.$executeRaw`UPDATE sessions SET blind = true WHERE code = ${M2.code}`
  const M3 = await createWith(Oo, { sessionName: `${TAG} Odile hidden`, dateFrom: inDays(2), hideLineup: true })
  const wd = await addW(M3.code, Oo, `${TAG} Delta`)
  check('fixture: Odile (the host) rates her hidden line-up', (await rateS(M3.code, Oo, wd, 5)).status === 200)

  // ── Impressions ──
  let r = await list('impressions', Oo, Vv)
  // Rows key on the RATING's id; a blind row of someone else's list carries
  // no wine id (moment-visibility step 1a), so the walks below resolve the
  // bottle from the rating.
  const wineOfRating = new Map((await prisma.$queryRaw<{ id: number; wine_id: string }[]>`SELECT id, wine_id FROM ratings WHERE user_id = ${Oo.id}`).map(x => [x.id, x.wine_id]))
  // (Cravings rows carry no rating id and always their wine id.)
  const wineOf = (i: J) => (i.wineId ?? wineOfRating.get(i.id as number)) as string | undefined
  const wineIds = (x: { json: J }) => (x.json.items as J[]).map(wineOf)
  check('impressions for Vera: newest post first, the hidden line-up LEFT OUT (had_at, not the re-rate)',
    JSON.stringify(wineIds(r)) === JSON.stringify([wc, wb, wa, soloWine]) && !wineIds(r).includes(wd), wineIds(r))
  const rowOf = (x: { json: J }, w: string) => (x.json.items as J[]).find(i => wineOf(i) === w) as J
  const blindRow = rowOf(r, wc)
  check('🔒 a blind row of someone else\'s list carries NO wine id (the rating id is the key); a shown row keeps it',
    !!blindRow && !('wineId' in blindRow) && typeof blindRow.id === 'number' && rowOf(r, wa)?.wineId === wa && !JSON.stringify(r.wire).includes(wc), blindRow)
  check('🔒 the blind row: no name / producer / vintage / photo, the moment name + score + style stay',
    blindRow?.blind === true && blindRow.name === '' && blindRow.producer === null && blindRow.vintage === null && blindRow.imageUrl === null && blindRow.score === 4 && blindRow.momentName === `${TAG} Blind night` && blindRow.type === 'red', blindRow)
  // 🔒 A legacy alcohol-free token on a blind row is the alcohol-free mark: none
  // there (step 7 review r1), the visible rows keep theirs.
  {
    await prisma.$executeRaw`UPDATE wines SET style = 'nonalc' WHERE id = ${wc}`
    const nr = await list('impressions', Oo, Vv)
    const nb = (nr.json.items as J[]).find(i => i.id === blindRow?.id)
    check('🔒 a blind Impressions row of a legacy alcohol-free bottle sends no `nonalc` token', !!nb && nb.blind === true && nb.type === null, nb)
    await prisma.$executeRaw`UPDATE wines SET style = 'red' WHERE id = ${wc}`
  }
  // Catalogue model change step 7 (Simon 2026-11-21): the rows carry the kind
  // (colour + sparkling, the snapshot), the blind one too, like its style.
  check('impression rows carry colour + sparkling (the app labels a sparkling rosé "Sparkling Rosé"), a blind row too',
    blindRow?.colour === 'red' && blindRow?.sparkling === false && (r.json.items as J[]).every(i => 'colour' in i && typeof i.sparkling === 'boolean'), r.json.items)
  check('🔒 "both had": commonCount 1 (the blind bottle both rated never counts), yourScore on the shared one, null on the blind one',
    r.json.commonCount === 1 && rowOf(r, wa)?.yourScore === 2.75 && blindRow?.yourScore === null && rowOf(r, wb)?.yourScore === null, { cc: r.json.commonCount, a: rowOf(r, wa) })
  check('impression rows carry the post id (session = the moment post, standalone = its own)', rowOf(r, wa)?.postId === (await postOf(Oo.id, M1.code)) && rowOf(r, wb)?.postId === rowOf(r, wa)?.postId && (r.json.items as J[])[3]?.postId === soloPost, r.json.items)
  check('common=1 → only the one you both had', JSON.stringify(wineIds(await list('impressions', Oo, Vv, 'common=1'))) === JSON.stringify([wa]))
  check('🔒 search never matches a blind row by its bottle name…', wineIds(await list('impressions', Oo, Vv, 'q=Gamma')).length === 0)
  check('…only by its moment name', JSON.stringify(wineIds(await list('impressions', Oo, Vv, `q=${encodeURIComponent('Blind night')}`))) === JSON.stringify([wc]))
  check('search by name finds a shown row', JSON.stringify(wineIds(await list('impressions', Oo, Vv, 'q=Beta'))) === JSON.stringify([wb]))
  check('score range 4 – 5 → only rows in range (unscored dropped)', JSON.stringify(wineIds(await list('impressions', Oo, Vv, 'min=4&max=5'))) === JSON.stringify([wc, wb]))
  check('score range validation: off-step, out of range, min > max → 400',
    (await list('impressions', Oo, Vv, 'min=0.1')).status === 400 && (await list('impressions', Oo, Vv, 'max=6')).status === 400 && (await list('impressions', Oo, Vv, 'min=4.5&max=4')).status === 400)
  const own = await list('impressions', Oo, Oo)
  check('your own impressions: the hidden line-up you host is there, the blind one is blind for you too, no commonCount',
    wineIds(own).includes(wd) && rowOf(own, wc)?.blind === true && !('commonCount' in own.json) && !('yourScore' in (own.json.items as J[])[0]), own.json)
  check('🔒 …and on your OWN list the blind row keeps its wine id (Edit / Delete Rating, Crave need it)', rowOf(own, wc)?.wineId === wc, rowOf(own, wc))
  // D7: the tile count is the list's total, across the D4 states.
  let t = await tiles(Oo, Vv)
  const ownT = await tiles(Oo, Oo)
  check('🔒 D7: Impressions tile == list total (Vera 4, Odile 5)', t.impressions?.count === 4 && ownT.impressions?.count === 5, { v: t.impressions, o: ownT.impressions })
  const web = await call(usersRoute.GET, 'GET', `/api/users/${Oo.pid}`, Vv, undefined, { id: Oo.pid })
  check('🔒 D7: the web Tastes count agrees (stats.checkins 4)', web.json.stats?.checkins === 4, web.json.stats)

  // ── Cravings ──
  const orphan = `orph${TAG.slice(-8)}`
  // A moment's bottle (origin 'session': the insert trigger would read a raw
  // session-less row as a check-in's) whose moment is gone and unrecorded.
  await prisma.$executeRaw`INSERT INTO wines (id, name, image_url, origin) VALUES (${orphan}, ${`${TAG} Orphan`}, ${urlOf('wines/orphan.png')}, 'session')`
  for (const w of [wa, we, wc, orphan]) await bookmark(Oo.id, w)
  await bookmark(Oo.id, wd)
  // Saved order ≠ id order (the first bookmark saved last), so "served as
  // Recently Saved" is distinguishable from an id order.
  await prisma.$executeRaw`UPDATE bookmarks SET saved_at = now() + interval '1 minute' WHERE user_id = ${Oo.id} AND wine_id = ${wa}`
  const cv = await list('cravings', Oo, Vv)
  const cIds = (x: { json: J }) => (x.json.items as J[]).map(i => i.wineId)
  check('🔒 Vera sees Odile\'s cravings minus the hidden line-up, the blind bottle and the one whose moment can\'t be found',
    JSON.stringify([...cIds(cv)].sort()) === JSON.stringify([wa, we].sort()), cIds(cv))
  check('their score + post where they rated it (post gate), null where not; no moment, no who-from, no time on the wire',
    rowOf(cv, wa)?.score === 3.5 && rowOf(cv, wa)?.postId === (await postOf(Oo.id, M1.code)) && rowOf(cv, we)?.score === null && rowOf(cv, we)?.postId === null
    && !/momentName|savedAt|saved_at|"key"|\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(cv.wire)), cv.wire)
  const cvOwn = await list('cravings', Oo, Oo)
  // Re-cast by design (catalogue model change step 5, spec § 5): a craving
  // whose source is hidden for its OWNER is left out of their own list too
  // (no blind row), and the remove key is the craving's id.
  check('your own cravings: four, the blind one LEFT OUT until its reveal, the orphan shown (named residual), the remove key = the craving id',
    cIds(cvOwn).length === 4 && !cIds(cvOwn).includes(wc) && /^\d+$/.test(String(rowOf(cvOwn, orphan)?.key)) && !('id' in (rowOf(cvOwn, orphan) ?? {})), cvOwn.json)
  t = await tiles(Oo, Vv)
  check('🔒 D7: Cravings tile == list total (Vera 2, Odile 4)', t.cravings?.count === 2 && (await tiles(Oo, Oo)).cravings?.count === 4, { v: t.cravings })
  const byScore = await list('cravings', Oo, Oo, 'sort=score')
  check('own sort=score: scored first (5, 3.5; the blind 4 left out), then unscored', JSON.stringify(cIds(byScore).slice(0, 2)) === JSON.stringify([wd, wa]) && !cIds(byScore).includes(wc), cIds(byScore))
  await prisma.user.update({ where: { id: Oo.id }, data: { checkinVisibility: 'only-me' } })
  const hiddenScores = await list('cravings', Oo, Vv, 'sort=score')
  const recentOrder = await list('cravings', Oo, Vv)
  check('🔒 posts hidden: no scores, no post ids, and sort=score is served as Recently Saved',
    (hiddenScores.json.items as J[]).every(i => i.score === null && i.postId === null) && JSON.stringify(cIds(hiddenScores)) === JSON.stringify(cIds(recentOrder))
    && JSON.stringify(cIds(recentOrder)) === JSON.stringify([wa, we]), { s: cIds(hiddenScores), r: cIds(recentOrder) })
  r = await list('impressions', Oo, Vv)
  check('🔒 posts hidden: impressions 200 empty, no commonCount', r.status === 200 && r.json.items.length === 0 && r.json.nextCursor === null && !('commonCount' in r.json), r.json)
  await prisma.user.update({ where: { id: Oo.id }, data: { checkinVisibility: null } })

  // The reveal time passes: the hidden line-up comes back on both list and tile.
  await prisma.$executeRaw`UPDATE sessions SET date_from = now() - interval '1 hour' WHERE code = ${M3.code}`
  t = await tiles(Oo, Vv)
  check('🔒 D7: after the reveal time, both lists and both tiles grow (impressions 5, cravings 3)',
    (await list('impressions', Oo, Vv)).json.items.length === 5 && t.impressions?.count === 5 && (await list('cravings', Oo, Vv)).json.items.length === 3 && t.cravings?.count === 3, t)
  await prisma.$executeRaw`UPDATE sessions SET date_from = now() + interval '2 days' WHERE code = ${M3.code}`

  // Paging: 33 standalone posts in groups that share an exact time (the id tiebreak).
  const Pg = await mkUser('Paula Pager')
  const base = Date.now() - 86_400_000
  for (let i = 0; i < 33; i++) {
    const w = `pg${TAG.slice(-8)}${i}`
    const at = new Date(base + Math.floor(i / 4) * 60_000)
    await prisma.$executeRaw`INSERT INTO wines (id, name) VALUES (${w}, ${`Pager ${i}`})`
    const [rt] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO ratings (wine_id, user_id, origin, rater_name, score, rated_at) VALUES (${w}, ${Pg.id}, 'standalone', 'Paula', 3, now()) RETURNING id`
    await prisma.$executeRaw`INSERT INTO feed_items (user_id, kind, rating_id, created_at) VALUES (${Pg.id}, 'standalone', ${rt.id}, ${at})`
  }
  const p1 = await list('impressions', Pg, Vv)
  const p2 = await list('impressions', Pg, Vv, `cursor=${encodeURIComponent(p1.json.nextCursor ?? '')}`)
  const all = [...p1.json.items, ...p2.json.items] as J[]
  check('impressions paging: 30 + 3, no repeat, no skip, a tie broken by id, the last page has no cursor',
    p1.json.items.length === 30 && p2.json.items.length === 3 && new Set(all.map(i => i.id)).size === 33 && p2.json.nextCursor === null
    && all.every((x, i) => i === 0 || all[i - 1].hadAt > x.hadAt || (all[i - 1].hadAt === x.hadAt && all[i - 1].id > x.id)), { n1: p1.json.items.length, n2: p2.json.items.length })
  check('Paula\'s tile count == her list total (33)', (await tiles(Pg, Vv)).impressions?.count === 33)

  // The cravings score cursor across the scored / unscored boundary: 30 scored
  // + 35 unscored → page 1 ends on a SCORED row (the next page is all NULLs:
  // the `OR score IS NULL` branch), page 2 ends on an UNSCORED one (the null
  // marker branch).
  const qs = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO sessions (code, name, created_at, date_from) VALUES (${`Q${TAG.slice(-9)}`.toUpperCase()}, 'Q moment', now(), now()) RETURNING id`
  for (let i = 0; i < 65; i++) {
    const w = `qq${TAG.slice(-8)}${i}`
    await prisma.$executeRaw`INSERT INTO wines (id, session_id, name) VALUES (${w}, ${qs[0].id}, ${`Q ${i}`})`
    if (i < 30) await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${w}, ${Pg.id}, ${qs[0].id}, 'session', 'Paula', ${1 + (i % 4)}::numeric, now())`
    await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, saved_at) VALUES (${Pg.id}, ${w}, ${new Date(base + Math.floor(i / 3) * 1000)})`
  }
  for (const sort of ['score', 'recent']) {
    const pages: J[][] = []
    let cur: string | null = null
    do {
      const c: { json: J } = await list('cravings', Pg, Vv, `sort=${sort}${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`)
      pages.push(c.json.items as J[]); cur = c.json.nextCursor
    } while (cur && pages.length < 5)
    const rows = pages.flat()
    const scores = rows.map(x => x.score as number | null)
    const firstNull = scores.indexOf(null)
    const scoreOrder = firstNull === 30 && scores.slice(firstNull).every(x => x === null) && scores.slice(0, 30).every((x, i, a) => i === 0 || (a[i - 1] as number) >= (x as number))
    check(`cravings ${sort} paging: 30 + 30 + 5, 65 distinct${sort === 'score' ? ', the 30 scored desc then every unscored (no skip or repeat at either boundary)' : ''}`,
      JSON.stringify(pages.map(x => x.length)) === '[30,30,5]' && new Set(rows.map(x => x.wineId)).size === 65 && (sort === 'recent' || scoreOrder), { sizes: pages.map(x => x.length), scores })
  }
  const pc = await list('cravings', Pg, Vv, 'sort=score')
  // Flip a MIDDLE character: the last base64url characters can carry padding
  // bits only, so a tail edit may decode to the very same bytes.
  const pcur = pc.json.nextCursor as string
  const tampered = pcur.slice(0, 20) + (pcur[20] === 'A' ? 'B' : 'A') + pcur.slice(21)
  check('🔒 the sealed cursor: tampered → empty; replayed by another viewer or on the other sort → empty',
    (await list('cravings', Pg, Vv, `sort=score&cursor=${tampered}`)).json.items.length === 0
    && (await list('cravings', Pg, Oo, `sort=score&cursor=${encodeURIComponent(pc.json.nextCursor)}`)).json.items.length === 0
    && (await list('cravings', Pg, Vv, `sort=recent&cursor=${encodeURIComponent(pc.json.nextCursor)}`)).json.items.length === 0)

  // The Impressions sorts (2026-11-14): 40 scored (17 quarter values, so score
  // ties) + 35 unrated (NULL and 0 alike), three to a shared post time (time
  // ties). Every sort pages 30 + 30 + 15 in exactly the order the comparator
  // gives, the score sorts across the scored → unrated boundary inside page 3
  // and on from an unrated cursor (page 3 ends unrated).
  const Ss = await mkUser('Sonia Sorter')
  for (let i = 0; i < 75; i++) {
    const w = `ss${TAG.slice(-8)}${i}`
    const at = new Date(base + Math.floor(i / 3) * 60_000)
    const score = i < 40 ? 1 + (i % 17) * 0.25 : i % 2 === 0 ? null : 0
    await prisma.$executeRaw`INSERT INTO wines (id, name) VALUES (${w}, ${`Sorter ${i}`})`
    const [rt] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO ratings (wine_id, user_id, origin, rater_name, score, rated_at) VALUES (${w}, ${Ss.id}, 'standalone', 'Sonia', ${score}::numeric, now()) RETURNING id`
    await prisma.$executeRaw`INSERT INTO feed_items (user_id, kind, rating_id, created_at) VALUES (${Ss.id}, 'standalone', ${rt.id}, ${at})`
  }
  const sortPages = async (sort: string | null) => {
    const pages: J[][] = []
    let cur: string | null = null
    do {
      const qs = [sort ? `sort=${sort}` : '', cur ? `cursor=${encodeURIComponent(cur)}` : ''].filter(Boolean).join('&')
      const c: { json: J } = await list('impressions', Ss, Vv, qs)
      pages.push(c.json.items as J[]); cur = c.json.nextCursor
    } while (cur && pages.length < 5)
    return pages
  }
  const byDate = (a: J, b: J) => (a.hadAt < b.hadAt ? -1 : a.hadAt > b.hadAt ? 1 : a.id - b.id)
  const want: Record<string, (a: J, b: J) => number> = {
    newest: (a, b) => byDate(b, a),
    oldest: byDate,
    highest: (a, b) => (a.score === null) !== (b.score === null) ? (a.score === null ? 1 : -1) : a.score !== b.score ? b.score - a.score : byDate(b, a),
    lowest: (a, b) => (a.score === null) !== (b.score === null) ? (a.score === null ? 1 : -1) : a.score !== b.score ? a.score - b.score : byDate(b, a),
  }
  const firstPages: Record<string, string> = {}
  for (const sort of ['newest', 'oldest', 'highest', 'lowest']) {
    const pages = await sortPages(sort)
    const rows = pages.flat()
    const expected = [...rows].sort(want[sort])
    firstPages[sort] = JSON.stringify(pages[0]?.map(x => x.id))
    check(`impressions ${sort}: 30 + 30 + 15, 75 distinct, exactly the ${sort} order (ties by time, then id)`,
      JSON.stringify(pages.map(x => x.length)) === '[30,30,15]' && new Set(rows.map(x => x.id)).size === 75
      && JSON.stringify(rows.map(x => x.id)) === JSON.stringify(expected.map(x => x.id))
      && (sort === 'newest' || sort === 'oldest' || (rows.slice(0, 40).every(x => x.score !== null) && rows.slice(40).every(x => x.score === null))),
      { sizes: pages.map(x => x.length), scores: rows.map(x => x.score) })
  }
  check('no sort and an unknown sort both read as newest', JSON.stringify((await sortPages(null))[0].map(x => x.id)) === firstPages.newest
    && JSON.stringify((await sortPages('bogus'))[0].map(x => x.id)) === firstPages.newest)
  const hi = await list('impressions', Ss, Vv, 'sort=highest')
  const hiCur = encodeURIComponent(hi.json.nextCursor as string)
  check('a cursor is bound to its sort: a highest cursor under lowest / newest / no sort → an empty page; garbage → empty',
    (await list('impressions', Ss, Vv, `sort=lowest&cursor=${hiCur}`)).json.items.length === 0
    && (await list('impressions', Ss, Vv, `sort=newest&cursor=${hiCur}`)).json.items.length === 0
    && (await list('impressions', Ss, Vv, `cursor=${hiCur}`)).json.items.length === 0
    && (await list('impressions', Ss, Vv, `sort=highest&cursor=${encodeURIComponent(Buffer.from(Buffer.from(hi.json.nextCursor as string, 'base64url').toString('utf8').replace(/^h\.[^.]+\./, 'h.1000.')).toString('base64url'))}`)).json.items.length === 0
    && (await list('impressions', Ss, Vv, 'sort=oldest&cursor=%%%')).json.items.length === 0)
  // A score OFF the quarter grid (no CHECK keeps the column on it, only the
  // write boundaries) still pages: the cursor carries the exact hundredths.
  // 31 rows at 4.30 + one at 2: page 2 must hold the 31st 4.30 and the 2.
  const Og = await mkUser('Otto Offgrid')
  for (let i = 0; i < 32; i++) {
    const w = `og${TAG.slice(-8)}${i}`
    await prisma.$executeRaw`INSERT INTO wines (id, name) VALUES (${w}, ${`Offgrid ${i}`})`
    const [rt] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO ratings (wine_id, user_id, origin, rater_name, score, rated_at) VALUES (${w}, ${Og.id}, 'standalone', 'Otto', ${i < 31 ? '4.30' : '2'}::numeric, now()) RETURNING id`
    await prisma.$executeRaw`INSERT INTO feed_items (user_id, kind, rating_id, created_at) VALUES (${Og.id}, 'standalone', ${rt.id}, ${new Date(base + i * 1000)})`
  }
  const og1 = await list('impressions', Og, Vv, 'sort=highest')
  const og2 = await list('impressions', Og, Vv, `sort=highest&cursor=${encodeURIComponent(og1.json.nextCursor as string)}`)
  const ogAll = [...og1.json.items, ...og2.json.items] as J[]
  check('an off-grid score pages exactly: 30 + 2, 32 distinct, the 2 last',
    og1.json.items.length === 30 && og2.json.items.length === 2 && new Set(ogAll.map(x => x.id)).size === 32 && ogAll[31]?.score === 2,
    { n1: og1.json.items.length, n2: og2.json.items.length })
  const ol1 = await list('impressions', Og, Vv, 'sort=lowest')
  const ol2 = await list('impressions', Og, Vv, `sort=lowest&cursor=${encodeURIComponent(ol1.json.nextCursor as string)}`)
  const olAll = [...ol1.json.items, ...ol2.json.items] as J[]
  check('…and under lowest: 30 + 2, 32 distinct, the 2 first (a rounded cursor repeated rows there)',
    ol1.json.items.length === 30 && ol2.json.items.length === 2 && new Set(olAll.map(x => x.id)).size === 32 && olAll[0]?.score === 2,
    { n1: ol1.json.items.length, n2: ol2.json.items.length })

  // ── someone's Moments: only shared ones, a code only where you are a member ──
  const M4 = await createWith(Hx, { sessionName: `${TAG} Odile only` }); await join(M4.code, Oo)
  const M5 = await createWith(Hx, { sessionName: `${TAG} Vera kicked` }); await join(M5.code, Oo); await join(M5.code, Vv)
  await prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked', role = 'taster' WHERE session_code = ${M5.code} AND user_id = ${Vv.id}`
  const M6 = await createWith(Hx, { sessionName: `${TAG} Vera banned` }); await join(M6.code, Oo); await join(M6.code, Vv)
  await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${M6.code}, ${`u:${Vv.id}`})`
  const M7 = await createWith(Hx, { sessionName: `${TAG} deleted` }); await join(M7.code, Oo); await join(M7.code, Vv)
  await prisma.$executeRaw`UPDATE sessions SET deleted_at = now() WHERE code = ${M7.code}`
  const mo = await list('moments', Oo, Vv, 'limit=30')
  const codes = (x: { json: J }) => (x.json.items as J[]).map(i => i.code)
  const notThere = [M3.code, M4.code, M5.code, M6.code, M7.code]
  check('🔒 Vera sees ONLY the moments she shares with Odile (both member rows, neither kicked, not banned, live)',
    JSON.stringify([...codes(mo)].sort()) === JSON.stringify([M1.code, M2.code].sort()), codes(mo))
  check('🔒 …no code, name or row of any other moment anywhere in the payload', !notThere.some(c => JSON.stringify(mo.wire).includes(c)) && !JSON.stringify(mo.wire).includes('Odile only'))
  check('otherCount = her other live memberships, unfiltered (hidden-host M3, M4, M5, M6)', mo.json.otherCount === 4, mo.json.otherCount)
  check('rows carry THEIR role (taster → null) and the moment\'s own fields', (mo.json.items as J[]).every(i => i.role === null && typeof i.name === 'string' && 'coverPhotoUrl' in i && 'address' in i))
  check('the shared filter: hosts = the host → both; = me / the owner / an unknown id → none',
    codes(await list('moments', Oo, Vv, `limit=30&hosts=u:${Hx.pid}`)).length === 2 && codes(await list('moments', Oo, Vv, 'limit=30&hosts=me')).length === 0
    && codes(await list('moments', Oo, Vv, `limit=30&hosts=u:${Oo.pid}`)).length === 0 && codes(await list('moments', Oo, Vv, 'limit=30&hosts=u:ZZZZZZZZZZZZ')).length === 0)
  check('…people = a friend who was there → that moment; a non-friend who was there → nothing',
    JSON.stringify(codes(await list('moments', Oo, Vv, `limit=30&people=u:${Ff.pid}`))) === JSON.stringify([M1.code]) && codes(await list('moments', Oo, Vv, `limit=30&people=u:${Nn.pid}`)).length === 0)
  check('…roles reads THEIR role: host → none, taster → both', codes(await list('moments', Oo, Vv, 'limit=30&roles=host')).length === 0 && codes(await list('moments', Oo, Vv, 'limit=30&roles=taster')).length === 2)
  check('…search over shared rows only (an unshared name finds nothing)', JSON.stringify(codes(await list('moments', Oo, Vv, `limit=30&q=${encodeURIComponent('Jura evening')}`))) === JSON.stringify([M1.code]) && codes(await list('moments', Oo, Vv, `limit=30&q=${encodeURIComponent('Odile only')}`)).length === 0)
  check('the kicked / banned viewer sees none of those two', codes(mo).every(c => c !== M5.code && c !== M6.code))
  check('Moments tile count == shared + other (6)', (await tiles(Oo, Vv)).moments?.count === (mo.json.items as J[]).length + mo.json.otherCount)
  // The search's LIKE escape (lib/momentFacets.ts): `_` matches itself. "q_v"
  // in "rq_vx" is a substring; its trigram similarity (0.25) is under the 0.3
  // threshold, so only a working ESCAPE finds it (the old `ESCAPE ''` didn't).
  const M8 = await createWith(Hx, { sessionName: `${TAG} rq_vx night` }); await join(M8.code, Oo); await join(M8.code, Vv)
  check('moments search: a literal `_` matches by substring (the escape works)', JSON.stringify(codes(await list('moments', Oo, Vv, 'limit=30&q=q_v'))) === JSON.stringify([M8.code]))
  await prisma.user.update({ where: { id: Oo.id }, data: { showMoments: false, showCravings: false } })
  const off = await list('moments', Oo, Vv, 'limit=30')
  const offC = await list('cravings', Oo, Vv)
  check('🔒 Show Moments / Cravings off: 200 empty, no otherCount', off.status === 200 && off.json.items.length === 0 && !('otherCount' in off.json) && offC.status === 200 && offC.json.items.length === 0, [off.json, offC.json])
  await prisma.user.update({ where: { id: Oo.id }, data: { showMoments: true, showCravings: true } })

  // The craving's moment FALLBACK (D4): a bottle unhooked from a running moment
  // (a ban / kick-delete sets wines.session_id NULL) whose rating still points
  // at it; the line-up is hidden. Without the fallback it would be "no moment
  // found" and show in full on the owner's own list and tile.
  const [hlRow] = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM sessions WHERE code = ${HL.code}`
  const unhooked = `uh${TAG.slice(-8)}`
  await prisma.$executeRaw`INSERT INTO wines (id, name, image_url, added_by_identity_id, origin) VALUES (${unhooked}, ${`${TAG} Unhooked`}, ${urlOf('wines/unhooked.png')}, ${`u:${Hx.id}`}, 'session')`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${unhooked}, ${Hx.id}, ${hlRow.id}, 'session', 'Hugo', 4, now())`
  await bookmark(Oo.id, unhooked)
  const ownAfter = await list('cravings', Oo, Oo)
  check('🔒 an unhooked bottle resolves its moment through its rating: hidden line-up → left out of the owner\'s own list, her tile count and someone\'s list',
    !cIds(ownAfter).includes(unhooked) && (await tiles(Oo, Oo)).cravings?.count === 4 && !cIds(await list('cravings', Oo, Vv)).includes(unhooked), cIds(ownAfter))
  check('🔒 …and it never becomes a picked Cravings photo', !(await listPickable('cravings', Oo.id, 50)).includes(urlOf('wines/unhooked.png')))
  await prisma.bookmark.deleteMany({ where: { userId: Oo.id, wineId: unhooked } })

  // ── gate states, 401, 400, limiter, headers ──
  await prisma.userBlock.create({ data: { blockerId: Nn.id, blockedId: Oo.id } })
  const gone = await Promise.all((['impressions', 'moments', 'cravings'] as const).map(k => list(k, Oo, Nn)))
  check('🔒 a block pair → 404 on all three (both directions read as gone)', gone.every(x => x.status === 404 && x.headers.get('cache-control') === 'private, no-store'), gone.map(x => x.status))
  const anonL = await Promise.all((['impressions', 'moments', 'cravings'] as const).map(k => list(k, Oo, {})))
  check('signed out → 401 (private, no-store)', anonL.every(x => x.status === 401 && x.headers.get('cache-control') === 'private, no-store'))
  const intId = await Promise.all((['impressions', 'moments', 'cravings'] as const).map(async k => { await resetLimits(); return call((k === 'impressions' ? impressionsRoute : k === 'moments' ? momentsListRoute : cravingsRoute).GET, 'GET', `/api/users/${Oo.id}/${k}`, Vv, undefined, { id: String(Oo.id) }) }))
  check('§ 18: an integer id is malformed on all three → 400', intId.every(x => x.status === 400))
  await resetLimits()
  for (const k of ['impressions', 'cravings', 'moments'] as const) await call((k === 'impressions' ? impressionsRoute : k === 'moments' ? momentsListRoute : cravingsRoute).GET, 'GET', `/api/users/${Oo.pid}/${k}`, Vv, undefined, { id: Oo.pid })
  check('D11: the three routes share rl:profile-lists:u (3 charges on one key)', (await redis.get(`rl:profile-lists:u:${Vv.id}:1m`)) === '3')

  // ── ?item= (D9) ──
  const m1Post = await postOf(Oo.id, M1.code)
  const item = async (v: User, q: string) => { await resetLimits(); return call(feedRoute.GET, 'GET', `/api/feed?${q}`, v) }
  let it = await item(Vv, `user=${Oo.pid}&item=${m1Post}`)
  check('?item= returns that one post in the list\'s page shape', it.status === 200 && it.json.items.length === 1 && it.json.items[0].session?.id === m1Post && it.json.nextCursor === null, it.json)
  it = await item(Vv, `user=${Oo.pid}&item=${await postOf(Vv.id, M1.code)}`)
  check('🔒 ?item= of ANOTHER author\'s post → the same 200 empty', it.status === 200 && it.json.items.length === 0 && it.json.nextCursor === null)
  it = await item(Vv, `user=${Oo.pid}&item=${await postOf(Oo.id, M3.code)}`)
  check('🔒 ?item= of a post whose line-up is hidden from you → the same 200 empty', it.status === 200 && it.json.items.length === 0)
  check('?item= without user → 400, a malformed id → 400', (await item(Vv, `item=${m1Post}`)).status === 400 && (await item(Vv, `user=${Oo.pid}&item=01`)).status === 400)

  // ── the feed: hidden moment posts are left out BEFORE paging ──
  const Pp = await mkUser('Pia Poster')
  await prisma.follow.create({ data: { followerId: Vv.id, followingId: Pp.id } })
  const hiddenTimes: string[] = []
  for (let i = 0; i < 21; i++) {
    const code = `H${TAG.slice(-8)}${i.toString(36)}`.toUpperCase()
    const [hs] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO sessions (code, name, host_user_id, created_at, date_from, hide_lineup) VALUES (${code}, 'Hidden', ${Hx.id}, now(), now() + interval '2 days', true) RETURNING id`
    const w = `hw${TAG.slice(-8)}${i}`
    await prisma.$executeRaw`INSERT INTO wines (id, session_id, name) VALUES (${w}, ${hs.id}, 'Secret')`
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${w}, ${Pp.id}, ${hs.id}, 'session', 'Pia', 4, now())`
    const at = new Date(Date.now() - i * 1000)
    hiddenTimes.push(at.toISOString())
    await prisma.$executeRaw`INSERT INTO feed_items (user_id, kind, session_id, created_at) VALUES (${Pp.id}, 'session', ${hs.id}, ${at})`
  }
  const vis = `V${TAG.slice(-9)}`.toUpperCase()
  const [vs] = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO sessions (code, name, host_user_id, created_at, date_from) VALUES (${vis}, 'Visible', ${Hx.id}, now(), now()) RETURNING id`
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name) VALUES (${`vw${TAG.slice(-8)}`}, ${vs.id}, 'Shown')`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${`vw${TAG.slice(-8)}`}, ${Pp.id}, ${vs.id}, 'session', 'Pia', 4, now())`
  const [visPost] = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO feed_items (user_id, kind, session_id, created_at) VALUES (${Pp.id}, 'session', ${vs.id}, now() - interval '1 hour') RETURNING id`
  await prisma.$executeRaw`INSERT INTO wines (id, name) VALUES (${`sw${TAG.slice(-8)}`}, 'Solo Shown')`
  const [sr] = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO ratings (wine_id, user_id, origin, rater_name, score, rated_at) VALUES (${`sw${TAG.slice(-8)}`}, ${Pp.id}, 'standalone', 'Pia', 3, now()) RETURNING id`
  const [soloP] = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO feed_items (user_id, kind, rating_id, created_at) VALUES (${Pp.id}, 'standalone', ${sr.id}, now() - interval '2 hours') RETURNING id`
  const ids = (x: { json: J }) => (x.json.items as J[]).filter(i => i.author.id === Pp.id).map(i => i.session?.id ?? i.checkin?.id)
  const fu = await item(Vv, `user=${Pp.pid}`)
  check('🔒 ?user=: a page of 21 hidden moment posts is left out IN the query: the visible moment post + the check-in survive, nextCursor null (no hidden time)',
    JSON.stringify(ids(fu)) === JSON.stringify([visPost.id, soloP.id]) && fu.json.nextCursor === null, { ids: ids(fu), c: fu.json.nextCursor })
  const net = await item(Vv, '')
  check('🔒 network feed: the same (no hidden post, no hidden time in the cursor)', JSON.stringify(ids(net)) === JSON.stringify([visPost.id, soloP.id]) && !hiddenTimes.includes(net.json.nextCursor), ids(net))
  const host = await item(Hx, `user=${Pp.pid}`)
  check('the moments\' host (bypass) sees the hidden posts: a full page with a cursor', ids(host).length === 20 && host.json.nextCursor !== null, ids(host).length)
  const wpP = await call(usersRoute.GET, 'GET', `/api/users/${Pp.pid}`, Vv, undefined, { id: Pp.pid })
  check('🔒 profileLoad (web): the grouped NOT keeps the visible moment post + the check-in, drops the hidden ones (never empties the moment query)',
    JSON.stringify((wpP.json.recentSessionPosts as J[]).map(x => x.id)) === JSON.stringify([visPost.id]) && (wpP.json.recentCheckins as J[]).length === 1, wpP.json.recentSessionPosts)

  // ── /api/me/ratings + /api/me/bookmarks (leak audit finding 1) ──
  const [hsid] = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM sessions WHERE code = ${HL.code}`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${hw}, ${Vv.id}, ${hsid.id}, 'session', 'Vera', 4, now())`
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id) VALUES (${Vv.id}, ${hw})`
  await bookmark(Vv.id, wc)
  await resetLimits()
  const mr = await call(meRatingsRoute.GET, 'GET', '/api/me/ratings', Vv)
  const mb = await call(meBookmarksRoute.GET, 'GET', '/api/me/bookmarks', Vv)
  const mrBlind = (mr.json as unknown as J[]).find(x => x.wine_id === wc)
  const mbNames = (mb.json as unknown as J[]).map(x => x.name)
  check('🔒 /api/me/ratings: the hidden line-up left out, the blind bottle a blind row',
    !(mr.json as unknown as J[]).some(x => x.wine_id === hw) && mrBlind?._blind === true && mrBlind.wine_name === '' && mrBlind.image_url === null && mrBlind.score === 4, mrBlind)
  // Re-cast by design (catalogue model change step 5, spec § 5): Saved has no
  // blind rows any more; a save whose bottle is hidden for you is left out
  // until its reveal, like the hidden line-up.
  check('🔒 /api/me/bookmarks: the hidden line-up AND the blind bottle left out (no blind row, no name)',
    mb.status === 200 && !mbNames.includes(`${TAG} Hidden Bottle`) && !mbNames.includes(`${TAG} Gamma`) && !mbNames.includes(''), mbNames)
  check('…and a shown row stays whole', (mr.json as unknown as J[]).find(x => x.wine_id === wa)?.wine_name === `${TAG} Alpha`)

  // ── § 12 extended: no moment code on any of the new reads ──
  const momentCodes = [M1.code, M2.code, M3.code, M4.code, M5.code, M6.code, M7.code, HL.code]
  const readAll = JSON.stringify([(await list('impressions', Oo, Vv)).wire, (await list('cravings', Oo, Vv)).wire, (await list('impressions', Oo, Oo)).wire, (await list('cravings', Oo, Oo)).wire, (await item(Vv, `user=${Oo.pid}&item=${m1Post}`)).wire])
  check('🔒 § 12: no impressions / cravings / ?item= payload carries a moment code', !momentCodes.some(c => readAll.includes(c)))
  }

  // ── § 20 the leak fixes (leak-fixes plan § 5) ────────────────────────────
  await leakFixes({ call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, scanKeys, TAG, s3: { store, mtimes, puts, deletes, urlOf, keyOf, endpoint: S3 }, PNG })

  // ── The canary over the whole run (every call() above and below) ─────────
  await usernames({ call, check, section, mkUser: (name: string) => mkUser(name, { username: true }), createSession, resetLimits, canary, prisma, redis, scanKeys, betterAuthServer, TAG, DB })

  // ── § 22 Filter Impressions: structure ranges + aroma picks (2026-11-14) ──
  {
  section('§ 22 impression filters: structure ranges, aroma picks, all / any, post-less rows')
  const Pp = await mkUser('Pia Palate')
  const Vw = await mkUser('Viktor Viewer')
  const checkin = async (name: string, body: Record<string, unknown>) => {
    await resetLimits()
    const c = await call(checkinsRoute.POST, 'POST', '/api/checkins', Pp, { occurrenceId: nanoid(), wineName: `${TAG} ${name}`, type: 'red', score: 3, ...body })
    if (c.status !== 201) throw new Error(`check-in ${name} ${c.status} ${JSON.stringify(c.json)}`)
    const w = (await prisma.$queryRaw<{ wine_id: string }[]>`SELECT r.wine_id FROM ratings r JOIN feed_items fi ON fi.rating_id = r.id WHERE fi.id = ${c.json.id as number}`)[0].wine_id
    return { post: c.json.id as number, wine: w }
  }
  // c1: sweet 1, acid 4 (the rest filled as None); dried apricot (pronounced) + lemon.
  const c1 = await checkin('F1', { flavors: { sweet: 1, acid: 4 }, aromas: [{ a: 'apricot', m: 'dried', p: true }, { a: 'lemon', m: null }] })
  // c2: sweet 3, tannin 2; a coarse "berry" + grape + dried (stored as raisin).
  const c2 = await checkin('F2', { flavors: { sweet: 3, tannin: 2 }, aromas: [{ a: 'fruity.berry', m: null }, { a: 'grape', m: 'dried' }] })
  // c3: no structure, no aromas.
  const c3 = await checkin('F3', { flavors: {} })
  // c4: sparkling (Bubbles), only the family "fruity".
  const c4 = await checkin('F4', { type: 'spark', flavors: { bubbles: 5, sweet: 2 }, aromas: [{ a: 'fruity', m: null }] })
  // c5: apricot, its post removed: on Viktor's list it stays (unfiltered) but no aroma / structure filter may match it.
  const c5 = await checkin('F5', { flavors: { sweet: 1 }, aromas: [{ a: 'apricot', m: null }] })
  await prisma.$executeRaw`DELETE FROM feed_items WHERE id = ${c5.post}`
  const raw = await prisma.$queryRaw<{ aromas: unknown }[]>`SELECT r.aromas FROM ratings r JOIN wines w ON w.id = r.wine_id WHERE w.id = ${c2.wine}`
  check('fixture: grape + dried was stored as raisin', JSON.stringify(raw[0]?.aromas).includes('"raisin"'), raw[0]?.aromas)
  const lst = async (viewer: User, q: string) => {
    await resetLimits()
    return call(impressionsRoute.GET, 'GET', `/api/users/${Pp.pid}/impressions${q ? `?${q}` : ''}`, viewer, undefined, { id: Pp.pid })
  }
  // By the rating (a blind row of someone else's list carries no wine id).
  const set = async (x: { json: J }) => {
    const items = (x.json.items ?? []) as J[]
    const rows = items.length ? await prisma.$queryRaw<{ id: number; wine_id: string }[]>`SELECT id, wine_id FROM ratings WHERE id = ANY(${items.map(i => i.id as number)}::int[])` : []
    const by = new Map(rows.map(x => [x.id, x.wine_id]))
    return items.map(i => by.get(i.id as number) as string).sort().join()
  }
  const of = (...cs: { wine: string }[]) => cs.map(c => c.wine).sort().join()
  const ar = (picks: unknown[], mode?: 'any') => `ar=${encodeURIComponent(JSON.stringify(picks))}${mode ? '&armode=any' : ''}`
  const expectSet = async (name: string, q: string, want: string, viewer: User = Vw) => {
    const x = await lst(viewer, q)
    const got = await set(x)
    check(name, x.status === 200 && got === want, { status: x.status, got, want })
  }
  await expectSet('unfiltered: all five (the post-less one too)', '', of(c1, c2, c3, c4, c5))
  // Structure.
  await expectSet('st sweet 1–1 → c1 only (c5 is post-less)', 'st=sweet:1-1', of(c1))
  await expectSet('st sweet 1–3 → c1, c2, c4', 'st=sweet:1-3', of(c1, c2, c4))
  await expectSet('st tannin None → the ones rated None (filled 0), never the unrated one', 'st=tannin:0-0', of(c1, c4))
  await expectSet('st bubbles 0–5 → only the sparkling rating carries the axis', 'st=bubbles:0-5', of(c4))
  await expectSet('two axes → both must fit', 'st=sweet:1-3,acid:4-5', of(c1))
  await expectSet('your own list: the post-less row matches', 'st=sweet:1-1', of(c1, c5), Pp)
  // Aromas.
  await expectSet('family → every subfamily and leaf under it (and itself)', ar([{ a: 'fruity' }]), of(c1, c2, c4))
  await expectSet('subfamily citrus → lemon', ar([{ a: 'fruity.citrus' }]), of(c1))
  await expectSet('never upward: strawberry misses a stored berry or fruity', ar([{ a: 'strawberry' }]), '')
  await expectSet('plain apricot finds dried apricot (c5 post-less: left out)', ar([{ a: 'apricot' }]), of(c1))
  await expectSet('your own list: plain apricot finds both', ar([{ a: 'apricot' }]), of(c1, c5), Pp)
  await expectSet('dried apricot → only dried', ar([{ a: 'apricot', m: 'dried' }]), of(c1))
  await expectSet('ripe apricot → none', ar([{ a: 'apricot', m: 'ripe' }]), '')
  await expectSet('Pronounced apricot → the marked one', ar([{ a: 'apricot', p: true }]), of(c1))
  await expectSet('Pronounced lemon → none (lemon is not marked)', ar([{ a: 'lemon', p: true }]), '')
  await expectSet('grape finds raisin (the promoted leaf)', ar([{ a: 'grape' }]), of(c2))
  await expectSet('fruity + dried finds dried apricot AND raisin', ar([{ a: 'fruity', m: 'dried' }]), of(c1, c2))
  await expectSet('all: lemon AND raisin → none', ar([{ a: 'lemon' }, { a: 'raisin' }]), '')
  await expectSet('any: lemon OR raisin → c1, c2', ar([{ a: 'lemon' }, { a: 'raisin' }], 'any'), of(c1, c2))
  await expectSet('aromas AND structure together', `${ar([{ a: 'fruity' }])}&st=sweet:2-3`, of(c2, c4))
  // Validation.
  const bad = async (q: string) => (await lst(Vw, q)).status === 400
  check('st validation: lo > hi, unknown axis, an axis twice, out of 0–5, junk → 400',
    (await bad('st=sweet:3-1')) && (await bad('st=nope:1-2')) && (await bad('st=sweet:1-2,sweet:2-3')) && (await bad('st=sweet:1-6')) && (await bad('st=sweet')))
  check('ar validation: not JSON, not an array, unknown id, a disallowed modifier, `p: null` → 400',
    (await bad('ar=nope')) && (await bad(`ar=${encodeURIComponent('{"a":"fruity"}')}`)) && (await bad(ar([{ a: 'nope' }]))) && (await bad(ar([{ a: 'apricot', m: 'smoked' }]))) && (await bad(ar([{ a: 'apricot', p: null }]))))
  void c3
  // The moment rules hold under the new filters: a blind moment's bottle (its
  // post shows her perception) matches and stays BLIND; a hidden line-up stays
  // left out for Viktor (on her own list too, unless she hosts it: she does).
  const Hb = await mkUser('Hedi Blindhost')
  const MB = await createSession(Hb)
  const wB = (await addWine(MB, Hb, `${TAG} Blind Bottle`)).id
  await join(MB, Pp)
  await resetLimits()
  const rb = await call(rateRoute.POST, 'POST', `/api/session/${MB}/rate`, Pp, { wineId: wB, score: 4, flavors: { sweet: 2 }, aromas: [{ a: 'grapefruit', m: null }], notes: 'n' }, { code: MB })
  await prisma.$executeRaw`UPDATE sessions SET blind = true WHERE code = ${MB}`
  await resetLimits()
  const MH = await call(sessionRoute.POST, 'POST', '/api/session', Pp, { hostDisplayName: 'Pia', sessionName: `${TAG} hidden`, dateFrom: new Date(Date.now() + 2 * 86_400_000).toISOString(), hideLineup: true, hideLineupMinutesBefore: 30 })
  const hCode = MH.json.code as string
  const wH = (await addWine(hCode, Pp, `${TAG} Hidden Bottle`)).id
  await resetLimits()
  const rh = await call(rateRoute.POST, 'POST', `/api/session/${hCode}/rate`, Pp, { wineId: wH, score: 4, flavors: { sweet: 2 }, aromas: [{ a: 'grapefruit', m: null }], notes: 'n' }, { code: hCode })
  check('fixture: the blind and the hidden ratings landed', rb.status === 200 && rh.status === 200, { rb: rb.status, rh: rh.status })
  const gx = await lst(Vw, ar([{ a: 'grapefruit' }]))
  const gRow = ((gx.json.items ?? []) as J[])[0]
  check('🔒 a blind bottle matches by her aromas and stays blind (no name, no photo); the hidden line-up is left out',
    gx.status === 200 && (gx.json.items as J[]).length === 1 && (await set(gx)) === wB && !('wineId' in gRow) && gRow.blind === true && gRow.name === '' && gRow.imageUrl === null, gx.json)
  await expectSet('🔒 the same with a structure range', 'st=sweet:2-2', of({ wine: wB }, c4))
  await expectSet('her own list: she hosts the hidden line-up, so it matches there', ar([{ a: 'grapefruit' }]), of({ wine: wB }, { wine: wH }), Pp)
  // A session sparkling wine re-typed to red after she rated it: her rating
  // keeps its bubbles value, but the post's wheel no longer draws Bubbles, so
  // the Bubbles filter must stop matching it (Codex review, 2026-11-14).
  const MS = await createSession(Hb)
  await resetLimits()
  const ws = await call(winesRoute.POST, 'POST', `/api/session/${MS}/wines`, Hb, { id: nanoid(), name: `${TAG} Fizz`, type: 'spark' }, { code: MS })
  await join(MS, Pp)
  await resetLimits()
  const rs = await call(rateRoute.POST, 'POST', `/api/session/${MS}/rate`, Pp, { wineId: ws.json.id, score: 4, flavors: { bubbles: 4 }, notes: 'n' }, { code: MS })
  check('fixture: the sparkling session rating landed', ws.status === 200 && rs.status === 200, { ws: ws.status, rs: rs.status })
  await expectSet('Bubbles 4–4 → the sparkling session wine', 'st=bubbles:4-4', of({ wine: ws.json.id as string }))
  // Re-typed the way a re-link does it (catalogue model change step 4: the
  // style token and its pair move together; the filter reads `sparkling`).
  await prisma.$executeRaw`UPDATE wines SET style = 'red', colour = 'red', sparkling = false WHERE id = ${ws.json.id as string}`
  const kept = await prisma.$queryRaw<{ b: unknown }[]>`SELECT flavors -> 'bubbles' AS b FROM ratings WHERE wine_id = ${ws.json.id as string}`
  check('fixture: re-typed to red, her rating still holds bubbles 4', Number(kept[0]?.b) === 4, kept)
  await expectSet('🔒 …then no longer (the wheel stopped drawing Bubbles)', 'st=bubbles:0-5', of(c4))
  }

  // ── § 23 Moment Visibility, step 1a ──────────────────────────────────────
  await momentVisibility({ call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, scanKeys, TAG, DB })

  section('canary: no response carried a user integer')
  check('🔒 no response body or header carried a fixture user integer, a u:<digit>, or a public id inside a URL', canaryViolations.length === 0, [...new Set(canaryViolations)].slice(0, 20))
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
