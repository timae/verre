// § 25 Moment Visibility, step 3: Only Inside This Moment and Hide from Feed
// (.local/moment-visibility/step3-plan.md § 4, § 7). Imported by
// scripts/tests/you-profile-integration.mts after § 24, with the same harness:
// every response through `call` passes the integer canary.
//   § 25 a insiderSql == grantStatus over every grant state
//   § 25 b every post surface, an Only Inside author AND a hidden check-in, per
//          viewer (author, member, kicked, banned, friend outside, stranger,
//          signed out), and after the moment's deletion (the author only)
//   § 25 c paging: no page ends on a hidden post, no cursor carries its time
//   § 25 d Impressions: the strip, q, "You ★", both had, the filters, hadAt
//   § 25 e Cravings: the three origins, each for owner / member / outsider
//   § 25 f the impression read
//   § 25 g tiles: the picker and the automatic cover skip; a pin falls back
//   § 25 h the writes and the state
//   § 25 i a flag OFF with stored rows: every reader still hides; the CHECK
//   § 25 j 1b's readers through the REAL write
//   § 25 k viewerCanSeePost's line-up term on the like routes
//   § 25 l the feed's network after a kick
//   § 25 m Hide from Feed on a moment post (R12)
//   § 25 n before / after a REAL follow: the plain posts and the look-in open,
//          Incognito and Hide from Feed still hide, an unfollow closes again
//   § 25 o two concurrent "show again" requests: one change, ONE charge (R10)
import { nanoid } from 'nanoid'
import type { MomentVisibilityHarness } from './moment-visibility-section.mts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Res = { status: number; json: J; wire: J; headers: Headers }

const SECRET = 'ci-only-moment-link-secret-0123456789-abcdef'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const sqlErr = (p: Promise<unknown>) => p.then(() => null as string | null, (e: Error) => String(e?.message ?? e))

export async function postPrivacy(h: MomentVisibilityHarness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, TAG } = h
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const sessionRoute = await import('../../app/api/session/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
  const meNameRoute = await import('../../app/api/session/[code]/me/name/route.ts')
  const mePrivacyRoute = await import('../../app/api/session/[code]/me/privacy/route.ts')
  const visibilityRoute = await import('../../app/api/session/[code]/visibility/route.ts')
  const linkRoute = await import('../../app/api/session/[code]/look-in-link/route.ts')
  const bookmarkRoute = await import('../../app/api/session/[code]/wines/[wineId]/bookmark/route.ts')
  const postPrivacyRoute = await import('../../app/api/feed-items/[id]/privacy/route.ts')
  const likeRoute = await import('../../app/api/feed-items/[id]/like/route.ts')
  const craveRoute = await import('../../app/api/feed-items/[id]/crave/route.ts')
  const checkinsRoute = await import('../../app/api/checkins/route.ts')
  const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const usersRoute = await import('../../app/api/users/[id]/route.ts')
  const impressionsRoute = await import('../../app/api/users/[id]/impressions/route.ts')
  const impressionRoute = await import('../../app/api/users/[id]/impressions/[ratingId]/route.ts')
  const cravingsRoute = await import('../../app/api/users/[id]/cravings/route.ts')
  const momentsListRoute = await import('../../app/api/users/[id]/moments/route.ts')
  const meBookmarksRoute = await import('../../app/api/me/bookmarks/route.ts')
  const lookInRoute = await import('../../app/api/moments/[publicId]/route.ts')
  const followRoute = await import('../../app/api/users/[id]/follow/route.ts')
  const { insiderSql, readGrant, grantStatus } = await import('../../lib/sessionGrant.ts')
  const { pagePostIds } = await import('../../lib/postPrivacy.ts')
  const { listPickable, resolveTilePhotos } = await import('../../lib/profileTiles.ts')
  const { loadSessionFeedWines } = await import('../../lib/sessionFeedWines.ts')
  const { Prisma } = await import('@prisma/client')

  const saved = { mv: process.env.MOMENT_LOOKIN_ENABLED, hff: process.env.HIDE_FROM_FEED_ENABLED, secret: process.env.MOMENT_LINK_SECRET }
  const flags = (mv: boolean, hff: boolean) => {
    if (mv) process.env.MOMENT_LOOKIN_ENABLED = 'true'; else delete process.env.MOMENT_LOOKIN_ENABLED
    if (hff) process.env.HIDE_FROM_FEED_ENABLED = 'true'; else delete process.env.HIDE_FROM_FEED_ENABLED
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  const mutual = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }, { followerId: b, followingId: a }], skipDuplicates: true })
  const follows = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }], skipDuplicates: true })
  const pub = (id: number) => prisma.user.update({ where: { id }, data: { profileVisibility: 'public-internet', checkinVisibility: null } })
  const join = async (code: string, a: Actor, name = 'Joiner') => {
    await resetLimits()
    const r = await call(joinRoute.POST, 'POST', '/api/session/join', a, { code, displayName: name })
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
    return r
  }
  const rate = async (code: string, a: Actor, wineId: string, score = 4, notes = 'p3 note') => {
    await resetLimits()
    const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, a, { wineId, score, flavors: { body: 3 }, aromas: [{ a: 'fruity', m: null }], notes }, { code })
    if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const remove = async (code: string, host: Actor, target: User, mode: 'kick' | 'ban') => {
    await resetLimits()
    const r = await call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, host, { identityId: `u:${target.pid}`, mode }, { code })
    if (r.status !== 200) throw new Error(`${mode} failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const checkin = async (u: User, name: string, o: { photo?: boolean; purchaseUrl?: string; description?: string } = {}) => {
    await resetLimits()
    const r = await call(checkinsRoute.POST, 'POST', '/api/checkins', u, {
      occurrenceId: nanoid(), wineName: name, score: 3.5, flavors: { body: 2 }, aromas: [{ a: 'fruity', m: null }], notes: `${name} note`,
      ...(o.purchaseUrl ? { purchaseUrl: o.purchaseUrl } : {}), ...(o.description ? { description: o.description } : {}),
    })
    if (r.status !== 201) throw new Error(`check-in failed ${r.status} ${JSON.stringify(r.json)}`)
    const id = r.json.id as number
    if (o.photo) {
      await resetLimits()
      const p = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${id}`, u, { imageData: PNG }, { id: String(id) })
      if (p.status !== 200) throw new Error(`check-in photo failed ${p.status}`)
    }
    return id
  }
  const mePrivacy = async (code: string, a: Actor, body: unknown, extra: Record<string, string> = {}) => {
    await resetLimits()
    return call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, a, body, { code }, extra)
  }
  const postPriv = async (id: number | string, a: Actor, body: unknown, o: { keep?: boolean; extra?: Record<string, string> } = {}) => {
    if (!o.keep) await resetLimits()
    return call(postPrivacyRoute.PATCH, 'PATCH', `/api/feed-items/${id}/privacy`, a, body, { id: String(id) }, o.extra ?? {})
  }
  const feed = async (v: Actor, q = '') => { await resetLimits(); return call(feedRoute.GET, 'GET', `/api/feed${q}`, v) }
  const ofUser = async (v: Actor, u: User, item?: number) => feed(v, `?user=${u.pid}${item ? `&item=${item}` : ''}`)
  const ids = (r: Res) => ((r.wire?.items ?? []) as J[]).map(i => (i.type === 'checkin' ? i.checkin.id : i.session.id) as number)
  const itemOf = (r: Res, id: number) => ((r.wire?.items ?? []) as J[]).find(i => (i.type === 'checkin' ? i.checkin.id : i.session.id) === id)
  const web = async (owner: User, v: Actor) => { await resetLimits(); return call(usersRoute.GET, 'GET', `/api/users/${owner.pid}`, v, undefined, { id: owner.pid }) }
  const webIds = (r: Res) => [...((r.wire?.recentCheckins ?? []) as J[]).map(c => c.id as number), ...((r.wire?.recentSessionPosts ?? []) as J[]).map(c => c.id as number)]
  const like = async (v: Actor, id: number, method: 'POST' | 'DELETE') => { await resetLimits(); return call(method === 'POST' ? likeRoute.POST : likeRoute.DELETE, method, `/api/feed-items/${id}/like`, v, undefined, { id: String(id) }) }
  const crave = async (v: Actor, id: number, method: 'POST' | 'DELETE', body?: unknown) => { await resetLimits(); return call(method === 'POST' ? craveRoute.POST : craveRoute.DELETE, method, `/api/feed-items/${id}/crave`, v, body, { id: String(id) }) }
  const sip = async (v: User, source: number) => { await resetLimits(); return call(checkinsRoute.POST, 'POST', '/api/checkins', v, { occurrenceId: nanoid(), wineName: `${TAG} p3 sip`, score: 3, flavors: {}, copyFromCheckinId: source }) }
  const impressions = async (owner: User, v: Actor, q = '') => { await resetLimits(); return call(impressionsRoute.GET, 'GET', `/api/users/${owner.pid}/impressions${q}`, v, undefined, { id: owner.pid }) }
  const impression = async (owner: User, v: Actor, ratingId: number | string, o: { keep?: boolean } = {}) => {
    if (!o.keep) await resetLimits()
    return call(impressionRoute.GET, 'GET', `/api/users/${owner.pid}/impressions/${ratingId}`, v, undefined, { id: owner.pid, ratingId: String(ratingId) })
  }
  const cravings = async (owner: User, v: Actor) => { await resetLimits(); return call(cravingsRoute.GET, 'GET', `/api/users/${owner.pid}/cravings`, v, undefined, { id: owner.pid }) }
  const momentsOf = async (owner: User, v: Actor, q = '') => { await resetLimits(); return call(momentsListRoute.GET, 'GET', `/api/users/${owner.pid}/moments${q}`, v, undefined, { id: owner.pid }) }
  const savedOf = async (v: Actor) => { await resetLimits(); return call(meBookmarksRoute.GET, 'GET', '/api/me/bookmarks', v) }
  const visGet = async (code: string, a: Actor) => { await resetLimits(); return call(visibilityRoute.GET, 'GET', `/api/session/${code}/visibility`, a, undefined, { code }) }
  const visPatch = async (code: string, a: Actor, body: unknown) => { await resetLimits(); return call(visibilityRoute.PATCH, 'PATCH', `/api/session/${code}/visibility`, a, body, { code }) }
  const look = async (pid: string, a: Actor) => { await resetLimits(); return call(lookInRoute.GET, 'GET', `/api/moments/${pid}`, a, undefined, { publicId: pid }) }
  const followOf = async (a: User, b: User, method: 'POST' | 'DELETE' = 'POST') => { await resetLimits(); return call(method === 'POST' ? followRoute.POST : followRoute.DELETE, method, `/api/users/${b.pid}/follow`, a, undefined, { id: b.pid }) }
  const sessionOf = async (code: string) => (await prisma.$queryRaw`SELECT id, public_id FROM sessions WHERE code = ${code}` as J[])[0] as { id: number; public_id: string }
  const postOf = async (userId: number, sessionId: number) => (await prisma.feedItem.findFirstOrThrow({ where: { userId, sessionId }, select: { id: true } })).id as number
  const ratingOf = async (userId: number, sessionId: number) => (await prisma.rating.findFirstOrThrow({ where: { userId, sessionId }, select: { id: true } })).id as number
  const ratingOfPost = async (postId: number) => (await prisma.feedItem.findUniqueOrThrow({ where: { id: postId }, select: { ratingId: true } })).ratingId as number
  const rlCount = async (key: string) => Number((await redis.get(key)) ?? 0)
  const noCharge = async (pattern: string) => (await h.scanKeys(pattern)).length === 0

  try {
    flags(true, true)
    process.env.MOMENT_LINK_SECRET = SECRET

    // ── the fixture ──────────────────────────────────────────────────────────
    const H = await mkUser('Pia Host'), A = await mkUser('Ada Author'), M = await mkUser('Max Member'), K = await mkUser('Kai Kicked')
    const X = await mkUser('Xen Banned'), F = await mkUser('Fay Friend'), S = await mkUser('Sol Stranger')
    for (const u of [H, A, M, K, X, F, S]) await pub(u.id)
    await mutual(A.id, F.id)
    const code = await createSession(H, 'Pia Host')
    for (const u of [A, M, K, X]) await join(code, u)
    const w1 = await addWine(code, H, `${TAG} P3 Red`)
    await prisma.$executeRaw`UPDATE wines SET description = 'p3 moment text', vinification = 'p3 moment process', purchase_url = 'https://shop.example.test/p3' WHERE id = ${w1.id}`
    for (const u of [A, M, K, X]) await rate(code, u, w1.id)
    const { id: sid, public_id: momentPid } = await sessionOf(code)
    // A name no bottle's name resembles (the list search is also a trigram match).
    await prisma.$executeRaw`UPDATE sessions SET name = 'Zephyrine Quokka Soiree' WHERE id = ${sid}`
    await prisma.$executeRaw`UPDATE wines SET region = 'Snapshotland', grape = 'Snapgrape', country = 'SN' WHERE id = ${w1.id}`
    const postA = await postOf(A.id, sid), postM = await postOf(M.id, sid)
    const ratingA = await ratingOf(A.id, sid)
    // In-moment save by A (origin 1), a save from A's post by F and by S (origin 3).
    await resetLimits()
    const savedInMoment = await call(bookmarkRoute.POST, 'POST', `/api/session/${code}/wines/${w1.id}/bookmark`, A, undefined, { code, wineId: w1.id })
    check('fixture: A saves the bottle inside the moment', savedInMoment.status === 200, savedInMoment)
    check('fixture: F and S save it from A\'s post (they are not in the moment)', (await crave(F, postA, 'POST', { ratingId: ratingA })).status === 200 && (await crave(S, postA, 'POST', { ratingId: ratingA })).status === 200)
    await remove(code, H, K, 'kick')
    await remove(code, H, X, 'ban')
    const hidCi = await checkin(A, `${TAG} P3 Hidden`, { photo: true, purchaseUrl: 'https://shop.example.test/hid', description: 'p3 own text' })
    const plainCi = await checkin(A, `${TAG} P3 Plain`, { photo: true, purchaseUrl: 'https://shop.example.test/plain' })
    const hidRating = await ratingOfPost(hidCi)
    // Before any choice: likes by F on both, F saves the hidden check-in's bottle.
    check('fixture: F likes the moment post and the check-in while they show', (await like(F, postA, 'POST')).status === 200 && (await like(F, hidCi, 'POST')).status === 200)
    check('fixture: F saves the check-in\'s bottle from it, and the plain one\'s', (await crave(F, hidCi, 'POST')).status === 200 && (await crave(F, plainCi, 'POST')).status === 200)
    check('fixture: A saves their own check-in\'s bottle (origin 2 on a check-in)', (await crave(A, hidCi, 'POST')).status === 200)

    // Baseline before any choice.
    const before = await ofUser(S, A)
    check('baseline: S sees A\'s moment post and both check-ins', [postA, hidCi, plainCi].every(i => ids(before).includes(i)), ids(before))
    const savedBefore = await savedOf(F)
    const fGroup = (r: Res, name: string) => (r.wire as unknown as J[]).find(g => String(g.name).includes(name))
    check('baseline: F\'s Saved shows the photo of the bottle saved from A\'s post', !!fGroup(savedBefore, 'P3 Red')?.image_url, fGroup(savedBefore, 'P3 Red'))
    const pickBefore = await listPickable('impressions', A.id, 50)
    check('baseline: the moment\'s wine photo is pickable for A\'s Impressions tile', pickBefore.includes(w1.url))

    // ── the REAL writes ──────────────────────────────────────────────────────
    const wA = await mePrivacy(code, A, { onlyInside: true })
    check('A: PATCH me/privacy { onlyInside: true } → 200 echoed', wA.status === 200 && wA.wire.onlyInside === true && JSON.stringify(Object.keys(wA.wire)) === '["onlyInside"]', wA)
    const wC = await postPriv(hidCi, A, { hiddenFromFeed: true })
    check('A: PATCH feed-items/:id/privacy { hiddenFromFeed: true } on a check-in → 200 echoed', wC.status === 200 && wC.wire.hiddenFromFeed === true, wC)
    check('stored: moment_privacy row, hidden_from_feed', (await prisma.momentPrivacy.findUnique({ where: { sessionId_userId: { sessionId: sid, userId: A.id } } }))?.onlyInside === true
      && (await prisma.feedItem.findUniqueOrThrow({ where: { id: hidCi } })).hiddenFromFeed === true)

    // ── § 25 a ───────────────────────────────────────────────────────────────
    section('§ 25 a insiderSql == grantStatus over every grant state')
    {
      const bareUser = async (name: string) => (await prisma.user.create({ data: { name, email: `${TAG}-p3a-${nanoid(6)}@example.test` }, select: { id: true } })).id as number
      const [hostNoRow, mem, coh, kik, ban, rater, kRater, str, hostKicked, hostBanned] = await Promise.all(
        ['Hn', 'Me', 'Co', 'Ki', 'Ba', 'Ra', 'Kr', 'St', 'Hk', 'Hb'].map(n => bareUser(`p3a ${n}`)))
      const rawMoment = async (hostId: number) => {
        const c = `PA${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`
        const [r] = await prisma.$queryRaw`INSERT INTO sessions (code, host_user_id, host_name, name, created_at, date_from) VALUES (${c}, ${hostId}, 'raw', ${`${TAG} p3a`}, now(), now() + interval '1 hour') RETURNING id` as J[]
        return { code: c, id: r.id as number }
      }
      const R1 = await rawMoment(hostNoRow), R2 = await rawMoment(hostKicked), R3 = await rawMoment(hostBanned)
      await prisma.sessionMember.createMany({ data: [
        { userId: mem, sessionCode: R1.code, role: 'taster' }, { userId: coh, sessionCode: R1.code, role: 'co_host' },
        { userId: kik, sessionCode: R1.code, role: 'taster', removedState: 'kicked' }, { userId: ban, sessionCode: R1.code, role: 'taster' },
        { userId: kRater, sessionCode: R1.code, role: 'taster', removedState: 'kicked' },
        { userId: hostKicked, sessionCode: R2.code, role: 'host', removedState: 'kicked' },
      ] })
      await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${R1.code}, ${`u:${ban}`}), (${R3.code}, ${`u:${hostBanned}`})`
      const wid = nanoid()
      await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, position, created_at, colour) VALUES (${wid}, ${R1.id}, 'p3a bottle', 0, now(), 'red')`
      for (const u of [rater, kRater]) await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${wid}, ${u}, ${R1.id}, 'session', 'r', 3, now())`
      const sql = async (v: number | null, s: number) => (await prisma.$queryRaw`SELECT ${insiderSql(v, Prisma.sql`${s}::integer`)} AS i` as J[])[0].i as boolean
      const viaGrant = async (v: number, c: string) => { const g = await readGrant(prisma, c, v); return !!g && grantStatus(g) === 'ok' }
      const cases: [string, number, { code: string; id: number }, boolean][] = [
        ['strict host without a member row', hostNoRow, R1, true], ['member', mem, R1, true], ['cohost', coh, R1, true],
        ['kicked member', kik, R1, false], ['banned member', ban, R1, false], ['a rater without a member row', rater, R1, true],
        ['a kicked rater', kRater, R1, false], ['a stranger', str, R1, false], ['a kicked strict host', hostKicked, R2, true], ['a banned strict host', hostBanned, R3, false],
      ]
      for (const [label, v, m, want] of cases) {
        const [a, b] = [await sql(v, m.id), await viaGrant(v, m.code)]
        check(`${label}: insiderSql ${a} == grantStatus ok ${b} (${want})`, a === b && a === want, { a, b })
      }
      check('a NULL viewer is never an insider', (await sql(null, R1.id)) === false)
      await prisma.$executeRaw`UPDATE sessions SET deleted_at = now(), code = NULL WHERE id = ${R1.id}`
      check('a deleted moment has no insiders (the member, the host)', !(await sql(mem, R1.id)) && !(await sql(hostNoRow, R1.id)))
    }

    // ── § 25 b ───────────────────────────────────────────────────────────────
    section('§ 25 b every post surface: an Only Inside author and a hidden check-in, per viewer')
    const viewers: [string, User, boolean][] = [['author', A, true], ['member', M, true], ['kicked', K, false], ['banned', X, false], ['friend outside', F, false], ['stranger', S, false]]
    for (const [label, v, insider] of viewers) {
      const u = await ofUser(v, A)
      const own = v.id === A.id
      check(`?user= (${label}): the moment post ${insider ? 'shows' : 'is out'}, the hidden check-in ${own ? 'shows' : 'is out'}, the plain one shows`,
        ids(u).includes(postA) === insider && ids(u).includes(hidCi) === own && ids(u).includes(plainCi), ids(u))
      const it1 = await ofUser(v, A, postA), it2 = await ofUser(v, A, hidCi)
      check(`?item= (${label}): the moment post ${insider ? 'found' : '200 empty'}, the hidden check-in ${own ? 'found' : '200 empty'}`,
        it1.status === 200 && it2.status === 200 && (ids(it1).length === 1) === insider && (ids(it2).length === 1) === own, [ids(it1), ids(it2)])
      const wp = await web(A, v)
      check(`web profile (${label}): the moment post ${insider ? 'shows' : 'is out'}, the hidden check-in ${own ? 'shows' : 'is out'}`,
        webIds(wp).includes(postA) === insider && webIds(wp).includes(hidCi) === own && webIds(wp).includes(plainCi), webIds(wp))
      if (!own) {
        const l1 = await like(v, postA, 'POST'), l2 = await like(v, hidCi, 'POST')
        check(`like POST (${label}): the moment post ${insider ? '200' : '404'}, the hidden check-in 404`, l1.status === (insider ? 200 : 404) && l2.status === 404, [l1.status, l2.status])
        const c1 = await crave(v, postA, 'POST', { ratingId: ratingA }), c2 = await crave(v, hidCi, 'POST')
        check(`crave POST from the post (${label}): the moment post ${insider ? '200' : '404'}, the hidden check-in 404`, c1.status === (insider ? 200 : 404) && c2.status === 404, [c1.status, c2.status])
        const d2 = await crave(v, hidCi, 'DELETE')
        check(`crave DELETE from the hidden check-in (${label}) → 404`, d2.status === 404, d2.status)
      }
    }
    // The network feed: F (a follow) and M (a buddy) have A in it; K, X, S don't.
    const nF = await feed(F), nM = await feed(M), nA = await feed(A)
    check('network: the friend outside sees the plain check-in, not the moment post, not the hidden check-in', ids(nF).includes(plainCi) && !ids(nF).includes(postA) && !ids(nF).includes(hidCi), ids(nF))
    check('network: the member sees the moment post, not the hidden check-in', ids(nM).includes(postA) && !ids(nM).includes(hidCi), ids(nM))
    check('network: the author sees all three (R7)', [postA, hidCi, plainCi].every(i => ids(nA).includes(i)), ids(nA))
    const soWeb = await web(A, {})
    check('signed out (web): neither the Only Inside post nor the hidden check-in; the plain one shows', soWeb.status === 200 && !webIds(soWeb).includes(postA) && !webIds(soWeb).includes(hidCi) && webIds(soWeb).includes(plainCi), webIds(soWeb))
    // Likes given before: F's like comes off with no count; S never liked → 404.
    const fd1 = await like(F, postA, 'DELETE'), fd2 = await like(F, hidCi, 'DELETE')
    check('like DELETE by F (liked before): 200 { liked: false }, NO count, on both', fd1.status === 200 && fd2.status === 200 && fd1.wire.liked === false && !('count' in fd1.wire) && !('count' in fd2.wire), [fd1, fd2])
    check('like DELETE by S (never liked) on both → 404', (await like(S, postA, 'DELETE')).status === 404 && (await like(S, hidCi, 'DELETE')).status === 404)
    const md = await like(M, postA, 'DELETE')
    check('like DELETE by the member (they see it): the count', md.status === 200 && typeof md.wire.count === 'number', md)
    check('had a sip from the hidden check-in (F follows A) → 400; the plain one → 201', (await sip(F, hidCi)).status === 400 && (await sip(F, plainCi)).status === 201)
    const fSaved = await savedOf(F)
    check('Saved (F): the bottle saved from A\'s Only Inside post shows no photo, no purchase link', fGroup(fSaved, 'P3 Red')?.image_url === null && fGroup(fSaved, 'P3 Red')?.purchase_url === null, fGroup(fSaved, 'P3 Red'))
    check('Saved (F): the bottle saved from the hidden check-in shows no photo, no purchase link', fGroup(fSaved, 'P3 Hidden')?.image_url === null && fGroup(fSaved, 'P3 Hidden')?.purchase_url === null, fGroup(fSaved, 'P3 Hidden'))
    check('Saved (F): the plain check-in\'s keeps its purchase link', fGroup(fSaved, 'P3 Plain')?.purchase_url === 'https://shop.example.test/plain', fGroup(fSaved, 'P3 Plain'))
    // Someone's Cravings saved-from-post: F's list, looked at by S, by A (the author), by F.
    const cS = await cravings(F, S), cA = await cravings(F, A), cF = await cravings(F, F)
    const row = (r: Res, name: string) => ((r.wire?.items ?? []) as J[]).find(x => String(x.name).includes(name))
    check('F\'s Cravings, saved from the hidden check-in: no bottle for S nor F; the author A sees it', !row(cS, 'P3 Hidden')?.wineId && !row(cS, 'P3 Hidden')?.imageUrl && !row(cF, 'P3 Hidden')?.wineId && !!row(cA, 'P3 Hidden')?.wineId,
      [row(cS, 'P3 Hidden'), row(cF, 'P3 Hidden'), row(cA, 'P3 Hidden')])
    check('F\'s Cravings, saved from A\'s Only Inside post: no bottle for S nor F; the author A sees it', !row(cS, 'P3 Red')?.wineId && !row(cF, 'P3 Red')?.wineId && !!row(cA, 'P3 Red')?.wineId,
      [row(cS, 'P3 Red'), row(cF, 'P3 Red'), row(cA, 'P3 Red')])
    check('T12: loadSessionFeedWines is unchanged (it reads whatever pair it is handed)', ((await loadSessionFeedWines([{ authorId: A.id, sessionId: sid }], S.id)).get(`${A.id}:${sid}`) ?? []).length === 1)

    // ── § 25 c ───────────────────────────────────────────────────────────────
    section('§ 25 c paging: no page ends on a hidden post, no cursor carries its time')
    {
      const P = await mkUser('Pag Ina'); await pub(P.id)
      const hid = await checkin(P, `${TAG} p3 page hidden`)
      check('fixture: P hides the oldest-but-20th check-in', (await postPriv(hid, P, { hiddenFromFeed: true })).status === 200)
      const older = await checkin(P, `${TAG} p3 page older`)
      await prisma.$executeRaw`UPDATE feed_items SET created_at = created_at - interval '1 minute' WHERE id = ${older}`
      for (let i = 0; i < 19; i++) await checkin(P, `${TAG} p3 page ${i}`)
      const hidAt = (await prisma.feedItem.findUniqueOrThrow({ where: { id: hid } })).createdAt.toISOString()
      const own = await ofUser(P, P)
      check('the author: 20 rows, the 20th IS the hidden post (it ends the raw page)', ids(own).length === 20 && ids(own)[19] === hid && own.wire.nextCursor === hidAt, [ids(own).length, own.wire.nextCursor])
      const out = await ofUser(S, P)
      check('🔒 S: a full page of 20 without it, the cursor is a VISIBLE post\'s time', ids(out).length === 20 && !ids(out).includes(hid) && ids(out)[19] === older && out.wire.nextCursor !== hidAt && out.wire.nextCursor !== null, [ids(out), out.wire.nextCursor])
      const page2 = await feed(S, `?user=${P.pid}&cursor=${encodeURIComponent(out.wire.nextCursor)}`)
      check('…and the next page never carries it', !ids(page2).includes(hid), ids(page2))
      // A's posts before the plain check-in: the hidden check-in, then the Only Inside post.
      const plainAt = (await prisma.feedItem.findUniqueOrThrow({ where: { id: plainCi } })).createdAt
      const lim1 = async (v: number) => (await pagePostIds({ viewerId: v, authors: [A.id], before: plainAt, hiddenSessions: [], limit: 1 })).map(r => r.id)
      check('pagePostIds, limit 1 (the exclusions sit before the LIMIT): S gets nothing, M the moment post, A the hidden check-in',
        JSON.stringify(await lim1(S.id)) === '[]' && JSON.stringify(await lim1(M.id)) === JSON.stringify([postA]) && JSON.stringify(await lim1(A.id)) === JSON.stringify([hidCi]),
        [await lim1(S.id), await lim1(M.id), await lim1(A.id)])
    }

    // ── § 25 d ───────────────────────────────────────────────────────────────
    section('§ 25 d Impressions: the strip, q, "You ★", both had, the filters, hadAt')
    {
      const rowsOf = (r: Res) => (r.wire?.items ?? []) as J[]
      const byRating = (r: Res, id: number) => rowsOf(r).find(x => x.id === id)
      const iK = await impressions(A, K), iM = await impressions(A, M), iA = await impressions(A, A), iS = await impressions(A, S)
      const k1 = byRating(iK, ratingA)!, m1 = byRating(iM, ratingA)!, a1 = byRating(iA, ratingA)!
      check('🔒 stripped (K, kicked, rated the same bottle row): no momentName, no wineId, no photo, no postId, yourScore null',
        !!k1 && !('momentName' in k1) && !('wineId' in k1) && k1.imageUrl === null && k1.postId === null && k1.yourScore === null, k1)
      check('…name, producer, score and date stay', k1.name.includes('P3 Red') && k1.score === 4 && typeof k1.hadAt === 'string', k1)
      check('the member and the owner see everything', m1.momentName && m1.wineId === w1.id && m1.postId === postA && a1.momentName && a1.wineId === w1.id && a1.postId === postA, [m1, a1])
      const momentName = m1.momentName as string
      check('q on the moment\'s name: misses for the outsider, hits for the member', !byRating(await impressions(A, S, `?q=${encodeURIComponent(momentName)}`), ratingA) && !!byRating(await impressions(A, M, `?q=${encodeURIComponent(momentName)}`), ratingA))
      check('q on the bottle\'s name hits for the outsider', !!byRating(await impressions(A, S, `?q=${encodeURIComponent('P3 Red')}`), ratingA))
      const kc = await impressions(A, K, '?common=1')
      check('🔒 "both had" never counts a stripped row (filter and count)', !byRating(kc, ratingA) && kc.wire.commonCount === 0, [rowsOf(kc).map(r => r.id), kc.wire.commonCount])
      const mc = await impressions(A, M, '?common=1')
      check('…the member\'s both-had counts it', !!byRating(mc, ratingA) && mc.wire.commonCount >= 1, mc.wire.commonCount)
      check('structure / aroma filters: the outsider misses the Only Inside row (its post is hidden), the member matches',
        !byRating(await impressions(A, S, '?st=body:3-3'), ratingA) && !!byRating(await impressions(A, M, '?st=body:3-3'), ratingA)
        && !byRating(await impressions(A, S, `?ar=${encodeURIComponent('[{"a":"fruity"}]')}`), ratingA) && !!byRating(await impressions(A, M, `?ar=${encodeURIComponent('[{"a":"fruity"}]')}`), ratingA))
      const sh = byRating(iS, hidRating)!, mh = byRating(iM, hidRating)!, ah = byRating(iA, hidRating)!
      check('the hidden check-in\'s row keeps its photo and loses its post (outsider AND member); the owner keeps both',
        !!sh.imageUrl && sh.postId === null && !!mh.imageUrl && mh.postId === null && ah.postId === hidCi, [sh, mh, ah])
      check('…and the filters miss it for others (post-less there)', !byRating(await impressions(A, S, '?st=body:2-2'), hidRating) && !!byRating(await impressions(A, A, '?st=body:2-2'), hidRating))
      const order = (r: Res) => rowsOf(r).filter(x => [ratingA, hidRating].includes(x.id)).map(x => `${x.id}@${x.hadAt}`).join()
      check('🔒 hadAt and the order of the hidden rows: identical for the owner, a member and an outsider', order(iA) === order(iM) && order(iM) === order(iS), [order(iA), order(iM), order(iS)])
      await prisma.$executeRaw`UPDATE ratings SET rated_at = now() + interval '1 day', score = 4.5 WHERE id = ${ratingA}`
      const [iA2, iS2] = [await impressions(A, A), await impressions(A, S)]
      check('…and after a re-rate (rated_at moves, hadAt does not)', order(iA2) === order(iS2) && byRating(iS2, ratingA)?.hadAt === k1.hadAt, [order(iA2), order(iS2)])
      await prisma.$executeRaw`UPDATE ratings SET score = 4 WHERE id = ${ratingA}`
    }

    // ── § 25 e ───────────────────────────────────────────────────────────────
    section('§ 25 e Cravings: the three origins, each for owner / member / outsider')
    {
      const row = (r: Res, name: string) => ((r.wire?.items ?? []) as J[]).find(x => String(x.name).includes(name))
      const [oA, oM, oS] = [await cravings(A, A), await cravings(A, M), await cravings(A, S)]
      const [a1, m1, s1] = [row(oA, 'P3 Red'), row(oM, 'P3 Red'), row(oS, 'P3 Red')]
      check('origin 1 (the craving\'s moment): owner and member see the bottle (id, photo); the outsider neither', a1?.wineId === w1.id && m1?.wineId === w1.id && !!m1?.imageUrl && !s1?.wineId && !s1?.imageUrl, [a1, m1, s1])
      check('origin 2 (the matched rating\'s post): the outsider gets no postId but keeps the score and the rating id; the member gets the post',
        s1?.postId === null && s1?.ratingId === ratingA && s1?.score === 4 && m1?.postId === postA && m1?.ratingId === ratingA, [s1, m1])
      const [a2, m2, s2] = [row(oA, 'P3 Hidden'), row(oM, 'P3 Hidden'), row(oS, 'P3 Hidden')]
      check('origin 2 on a hidden check-in: others get no postId, keep the rating id and its photo; the owner keeps the post',
        s2?.postId === null && s2?.ratingId === hidRating && !!s2?.imageUrl && m2?.postId === null && a2?.postId === hidCi, [a2, m2, s2])
      // Origin 3: F's craving from A's Only Inside post, looked at by F (owner), M (member), S (outsider).
      const [fF, fM, fS] = [await cravings(F, F), await cravings(F, M), await cravings(F, S)]
      check('origin 3 (saved from the post): the owner F and the outsider S see no bottle; the member M does',
        !row(fF, 'P3 Red')?.wineId && !row(fS, 'P3 Red')?.wineId && row(fM, 'P3 Red')?.wineId === w1.id, [row(fF, 'P3 Red'), row(fM, 'P3 Red'), row(fS, 'P3 Red')])
    }

    // ── § 25 f ───────────────────────────────────────────────────────────────
    section('§ 25 f the impression read')
    {
      const st = await impression(A, S, ratingA)
      check('a stripped row: 200, the full impression (score, notes, structure, aromas, date)',
        st.status === 200 && st.wire.score === 4 && st.wire.notes === 'p3 note' && st.wire.flavors?.body === 3 && st.wire.aromas?.[0]?.a === 'fruity' && typeof st.wire.hadAt === 'string', st)
      check('🔒 …no wine id, no moment text (description, vinification, purchase link), no moment photo, no post id, no moment',
        !('wineId' in st.wire) && st.wire.description === null && st.wire.vinification === null && st.wire.purchaseUrl === null && st.wire.imageUrl === null
        && !('postId' in st.wire) && !('momentName' in st.wire) && !JSON.stringify(st.wire).includes(code) && !JSON.stringify(st.wire).includes(momentPid), st.wire)
      check('the byline: the owner by public id, as the feed\'s author', st.wire.author?.id === A.pid && st.wire.author?.name === 'Ada Author' && JSON.stringify(Object.keys(st.wire.author).sort()) === JSON.stringify(['id', 'imageUrl', 'name', 'username', 'xp']), st.wire.author)
      check('🔒 …grape / region / country never from the bottle\'s snapshot (the catalogue entry\'s only)', st.wire.grape !== 'Snapgrape' && st.wire.region !== 'Snapshotland' && st.wire.country !== 'SN', st.wire)
      const mem = await impression(A, M, ratingA)
      check('the member: the wine id and the moment text', mem.wire.wineId === w1.id && mem.wire.description === 'p3 moment text' && mem.wire.purchaseUrl === 'https://shop.example.test/p3', mem.wire)
      const hc = await impression(A, S, hidRating)
      check('a hidden check-in: its own text and photo, its wine id', hc.status === 200 && hc.wire.description === 'p3 own text' && hc.wire.purchaseUrl === 'https://shop.example.test/hid' && !!hc.wire.imageUrl && typeof hc.wire.wineId === 'string', hc.wire)
      // A blind moment of A's.
      const H2 = await mkUser('Bea Blindhost')
      const cB = await createSession(H2, 'Bea Blindhost')
      await join(cB, A)
      const wb = await addWine(cB, H2, `${TAG} P3 Blind Label`)
      await rate(cB, A, wb.id)
      const sB = await sessionOf(cB)
      await prisma.$executeRaw`UPDATE sessions SET blind = true WHERE id = ${sB.id}`
      const bl = await impression(A, S, await ratingOf(A.id, sB.id))
      check('🔒 a blind row: blind, no name, no wine id, no photo, no moment text', bl.status === 200 && bl.wire.blind === true && bl.wire.name === '' && !('wineId' in bl.wire) && bl.wire.imageUrl === null && bl.wire.description === null && !JSON.stringify(bl.wire).includes('Blind Label'), bl.wire)
      // A hidden line-up.
      const H3 = await mkUser('Lia Lineup')
      const cL = await createSession(H3, 'Lia Lineup')
      await join(cL, A)
      const wl = await addWine(cL, H3, `${TAG} P3 Hidden Lineup`)
      await rate(cL, A, wl.id)
      const sL = await sessionOf(cL)
      await prisma.$executeRaw`UPDATE sessions SET hide_lineup = true, hide_lineup_minutes_before = 60, date_from = now() + interval '2 hours' WHERE id = ${sL.id}`
      const nf = await impression(A, S, await ratingOf(A.id, sL.id))
      const other = await impression(A, S, await ratingOf(M.id, sid))
      const unknown = await impression(A, S, 2_000_000_000)
      const shape = (r: Res) => JSON.stringify([r.status, r.wire, r.headers.get('cache-control')])
      check('🔒 one 404 for a hidden line-up, another owner\'s rating, an unknown id', nf.status === 404 && shape(nf) === shape(other) && shape(other) === shape(unknown), [nf.status, other.status, unknown.status])
      const bad = await Promise.all(['abc', '0', '012', '2147483648', '-1', '1e3'].map(x => impression(A, S, x)))
      check('…and for a malformed or out-of-range id', bad.every(r => shape(r) === shape(unknown)), bad.map(r => r.status))
      await prisma.user.update({ where: { id: A.id }, data: { checkinVisibility: 'only-me' } })
      check('the post gate: posts hidden from the viewer → the same 404', shape(await impression(A, S, hidRating)) === shape(unknown))
      await prisma.user.update({ where: { id: A.id }, data: { checkinVisibility: null } })
      await resetLimits()
      await redis.set(`rl:profile-lists:u:${S.id}:1m`, '60', { EX: 60 })
      const lim = await impression(A, S, ratingA, { keep: true })
      const limList = await call(impressionsRoute.GET, 'GET', `/api/users/${A.pid}/impressions`, S, undefined, { id: A.pid })
      check('the limiter is the lists\' own (rl:profile-lists): a spent budget answers 429 on both', lim.status === 429 && limList.status === 429, [lim.status, limList.status])
      await resetLimits()
      const before = await rlCount(`rl:profile-lists:u:${S.id}:1m`)
      await impression(A, S, ratingA, { keep: true })
      check('…and one impression read charges it once', (await rlCount(`rl:profile-lists:u:${S.id}:1m`)) === before + 1)
      check('private, no-store on every answer', [st, nf, bad[0]].every(r => r.headers.get('cache-control') === 'private, no-store'))
    }

    // ── § 25 g ───────────────────────────────────────────────────────────────
    section('§ 25 g tiles: the picker and the automatic cover skip, a pin falls back for others')
    {
      const cover = 'https://s3.example.test/verre/sessions/p3cover.png'
      await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${cover} WHERE id = ${sid}`
      check('Impressions picker: the Only Inside moment\'s wine photo is gone, the own check-in photos stay',
        !(await listPickable('impressions', A.id, 50)).includes(w1.url) && (await listPickable('impressions', A.id, 50)).length >= 2)
      check('Moments picker: the Only Inside moment\'s cover is gone; the member\'s picker keeps it', !(await listPickable('moments', A.id, 50)).includes(cover) && (await listPickable('moments', M.id, 50)).includes(cover))
      check('Cravings picker: the bottle of A\'s craving from that moment is gone', !(await listPickable('cravings', A.id, 50)).includes(w1.url))
      const autoS = await resolveTilePhotos(A.id, ['impressions', 'moments', 'cravings'], S.id)
      check('the automatic photos never use one', autoS.impressions?.imageUrl !== w1.url && autoS.moments?.imageUrl !== cover && autoS.cravings?.imageUrl !== w1.url, autoS)
      await prisma.$executeRaw`UPDATE users SET tile_impressions_url = ${w1.url}, tile_moments_url = ${cover} WHERE id = ${A.id}`
      const own = await resolveTilePhotos(A.id, ['impressions', 'moments'], A.id)
      check('a pin from the Only Inside moment shows to its owner', own.impressions?.imageUrl === w1.url && own.impressions.pinned && own.moments?.imageUrl === cover, own)
      const others = await Promise.all([S.id, M.id, null].map(v => resolveTilePhotos(A.id, ['impressions', 'moments'], v)))
      check('🔒 …everyone else (an outsider, a member, signed out) gets the automatic photo', others.every(o => o.impressions?.imageUrl !== w1.url && !o.impressions?.pinned && o.moments?.imageUrl !== cover), others)
      const pinsNow = (await prisma.$queryRaw`SELECT tile_impressions_url AS i, tile_moments_url AS m FROM users WHERE id = ${A.id}` as J[])[0]
      check('…and the pins stay stored', pinsNow.i === w1.url && pinsNow.m === cover, pinsNow)
      flags(false, false)
      check('the fallback holds with the flags off (T1)', (await resolveTilePhotos(A.id, ['impressions'], S.id)).impressions?.imageUrl !== w1.url)
      flags(true, true)
      await prisma.$executeRaw`UPDATE users SET tile_impressions_url = NULL, tile_moments_url = NULL WHERE id = ${A.id}`
    }

    // ── § 25 h ───────────────────────────────────────────────────────────────
    section('§ 25 h the writes and the state')
    {
      // The moment route, per caller.
      const r = await Promise.all([M, H].map(u => mePrivacy(code, u, { onlyInside: false })))
      check('a member and the host: 200', r.every(x => x.status === 200 && x.wire.onlyInside === false), r.map(x => x.status))
      const kk = await mePrivacy(code, K, { onlyInside: true }), xx = await mePrivacy(code, X, { onlyInside: true }), ss = await mePrivacy(code, S, { onlyInside: true })
      check('kicked and banned: the removed bounce; a stranger: 401', kk.headers.get('x-vr-auth') === 'removed' && xx.headers.get('x-vr-auth') === 'removed' && ss.status === 401, [kk.status, xx.status, ss.status])
      const bodies = await Promise.all([{}, { onlyInside: 'yes' }, { onlyInside: true, x: 1 }, [true], null].map(b => mePrivacy(code, M, b)))
      check('a bad body → 400', bodies.every(x => x.status === 400), bodies.map(x => x.status))
      check('isSameOrigin: a foreign origin → 403', (await mePrivacy(code, M, { onlyInside: true }, { origin: 'https://evil.example', host: 'localhost:3000' })).status === 403)
      flags(false, true)
      await resetLimits()
      const off = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, M, { onlyInside: true }, { code })
      check('the Moment Visibility flag off → 404, nothing charged', off.status === 404 && await noCharge('rl:post-privacy:*'), off.status)
      flags(true, true)
      // No record: a guest-hosted moment.
      await resetLimits()
      const gc = await call(sessionRoute.POST, 'POST', '/api/session', {}, { hostDisplayName: 'Gus Guesthost', sessionName: `${TAG} p3 guest`, dateFrom: new Date(Date.now() + 3600_000).toISOString() })
      const gHost: Actor = { anon: gc.wire.anonToken }
      await resetLimits()
      const nr = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${gc.wire.code}/me/privacy`, gHost, { onlyInside: true }, { code: gc.wire.code })
      check('a moment with no record → 403, before the limiter (nothing charged)', nr.status === 403 && await noCharge('rl:post-privacy:*'), nr)
      const gv = await visGet(gc.wire.code, gHost)
      check('…its visibility GET carries me: null', gv.status === 200 && gv.wire.me === null, gv.wire)
      // The shared limiter (R10, ruled 2026-11-24: hiding is never refused or
      // counted; showing again counts, and only on a change).
      await resetLimits()
      await redis.set(`rl:post-privacy:u:${A.id}:1h`, '30', { EX: 3600 })
      const l1 = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, A, { onlyInside: false }, { code })
      const l2 = await postPriv(postA, A, { onlyInside: false }, { keep: true })
      check('one budget for both routes (30/h per user): a spent one refuses SHOWING again on both (429)', l1.status === 429 && l2.status === 429, [l1.status, l2.status])
      const h1 = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, A, { onlyInside: true }, { code })
      const h2 = await postPriv(plainCi, A, { hiddenFromFeed: true }, { keep: true })
      check('🔒 R10: hiding is never refused, a spent budget included (both routes)', h1.status === 200 && h2.status === 200 && h2.wire.hiddenFromFeed === true, [h1.status, h2.status])
      await resetLimits()
      check('…showing again after it is charged once', (await postPriv(plainCi, A, { hiddenFromFeed: false }, { keep: true })).status === 200 && (await rlCount(`rl:post-privacy:u:${A.id}:1h`)) === 1)
      await resetLimits()
      const hideFree = await mePrivacy(code, M, { onlyInside: true })
      const noop = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, M, { onlyInside: true }, { code })
      check('a hide charges nothing, and neither does a no-op', hideFree.status === 200 && noop.status === 200 && await noCharge('rl:post-privacy:*'))
      const show = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, M, { onlyInside: false }, { code })
      const showNoop = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, M, { onlyInside: false }, { code })
      check('showing again is charged once; showing what is already shown is not', show.status === 200 && showNoop.status === 200 && (await rlCount(`rl:post-privacy:u:${M.id}:1h`)) === 1)
      await resetLimits()
      // The post route's show path (recheck 2026-11-24): someone else's or an
      // unknown post is the one 404, uncharged, also on a spent budget (never a
      // 429 that would tell it apart); a no-op show is free for both fields.
      const fs1 = await postPriv(postM, A, { onlyInside: false }, { keep: true }), fs2 = await postPriv(2_000_000_000, A, { hiddenFromFeed: false }, { keep: true })
      check('🔒 show on someone else\'s / an unknown post: 404, nothing charged', fs1.status === 404 && fs2.status === 404 && await noCharge('rl:post-privacy:*'), [fs1.status, fs2.status])
      await redis.set(`rl:post-privacy:u:${A.id}:1h`, '30', { EX: 3600 })
      check('🔒 …still the 404 (not 429) on a spent budget', (await postPriv(postM, A, { onlyInside: false }, { keep: true })).status === 404)
      await resetLimits()
      const pn1 = await postPriv(plainCi, A, { hiddenFromFeed: false }, { keep: true }), pn2 = await postPriv(postM, M, { onlyInside: false }, { keep: true })
      check('the post route\'s no-op show (both fields): 200 echoed, nothing charged', pn1.status === 200 && pn1.wire.hiddenFromFeed === false && pn2.status === 200 && pn2.wire.onlyInside === false && await noCharge('rl:post-privacy:*'), [pn1.wire, pn2.wire])
      // The guests: per moment and address, the SREM / SADD, the look-in.
      const g = await join(code, {}, 'Gwen Guestpthree')
      const G: Actor = { anon: g.wire.anonToken }, gid = String(g.wire.id)
      check('a guest is minted shown', await redis.sIsMember(k.shown(code), gid))
      const gm = await visGet(code, G)
      check('the guest\'s GET: me.onlyInside false, and NO moment id on a guest\'s me', gm.wire.me?.onlyInside === false && !('sessionId' in gm.wire.me), gm.wire)
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${sid}`
      check('the look-in names the shown guest', JSON.stringify((await look(momentPid, S)).wire).includes('Gwen Guestpthree'))
      const gh = await mePrivacy(code, G, { onlyInside: true })
      check('the guest hides: 200, SREM from shown, nothing charged (R10)', gh.status === 200 && !(await redis.sIsMember(k.shown(code), gid)) && await noCharge('rl:post-privacy:*'), gh)
      check('the look-in no longer names them', !JSON.stringify((await look(momentPid, S)).wire).includes('Gwen Guestpthree'))
      await resetLimits()
      await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, G, { onlyInside: false }, { code })
      const gKey = (await h.scanKeys(`rl:post-privacy:ip:${code}:*`))[0]
      check('showing again is charged per moment and address', !!gKey && (await rlCount(gKey)) === 1, gKey)
      await resetLimits()
      const gNoop = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, G, { onlyInside: false }, { code })
      check('the guest\'s no-op show: 200, nothing charged', gNoop.status === 200 && gNoop.wire.onlyInside === false && await noCharge('rl:post-privacy:*'))
      await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, G, { onlyInside: true }, { code })
      await redis.set(gKey, '120', { EX: 3600 })
      const gl = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, G, { onlyInside: false }, { code })
      const gh2 = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, G, { onlyInside: true }, { code })
      check('the guests\' budget: 120/h per moment and address refuses showing; 🔒 hiding still passes (a venue\'s guests can always hide)', gl.status === 429 && gh2.status === 200 && !(await redis.sIsMember(k.shown(code), gid)), [gl.status, gh2.status])
      await resetLimits()
      await call(meNameRoute.PATCH, 'PATCH', `/api/session/${code}/me/name`, G, { name: 'Gwen Renamed' }, { code })
      await join(code, {}, 'Gwen Again')
      check('🔒 a hidden guest stays hidden through a rename and another join', !(await redis.sIsMember(k.shown(code), gid)))
      await redis.del(k.shown(code))
      const ev = await visGet(code, G)
      check('🔒 an evicted shown: me.onlyInside reads true (fails closed)', ev.wire.me?.onlyInside === true, ev.wire)
      const gs = await mePrivacy(code, G, { onlyInside: false })
      check('showing again: SADD with the roster\'s TTL', gs.status === 200 && await redis.sIsMember(k.shown(code), gid) && Number(await redis.pTTL(k.shown(code))) > 0, gs)
      await mePrivacy(code, G, { onlyInside: true })
      await redis.del(k.meta(code))
      await resetLimits()
      await call(stateRoute.GET, 'GET', `/api/session/${code}/state`, M, undefined, { code })
      check('🔒 …and a rebuild never re-adds them', !(await redis.sIsMember(k.shown(code), gid)))
      // me on every answer of the shape: the host Only Inside changes the audience, then shares the link.
      await mePrivacy(code, H, { onlyInside: true })
      const hg = await visGet(code, H)
      const hp = await visPatch(code, H, { visibility: 'followers' })
      await resetLimits()
      const hl = await call(linkRoute.POST, 'POST', `/api/session/${code}/look-in-link`, H, { action: 'share' }, { code })
      check('🔒 me.onlyInside stays true on the GET, the visibility PATCH and the link POST', hg.wire.me?.onlyInside === true && hp.wire.me?.onlyInside === true && hl.wire.me?.onlyInside === true, [hg.wire.me, hp.wire.me, hl.wire.me])
      await mePrivacy(code, H, { onlyInside: false })
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends' WHERE id = ${sid}`
      // The post route.
      const aCi = await postPriv(plainCi, A, { onlyInside: true })
      check('Incognito on a check-in → 404 (a moment post\'s choice only; Hide from Feed works on both kinds since R12, § 25 m)', aCi.status === 404, aCi.status)
      const two = await postPriv(postA, A, { onlyInside: true, hiddenFromFeed: true }), none = await postPriv(postA, A, {}), nb = await postPriv(postA, A, { onlyInside: 1 })
      check('two fields, none, or not a boolean → 400', two.status === 400 && none.status === 400 && nb.status === 400, [two.status, none.status, nb.status])
      check('someone else\'s post, an unknown id, a malformed id → 404', (await postPriv(postM, A, { onlyInside: true })).status === 404 && (await postPriv(2_000_000_000, A, { onlyInside: true })).status === 404 && (await postPriv('01', A, { onlyInside: true })).status === 404)
      check('signed out → 401; a foreign origin → 403', (await postPriv(postA, {}, { onlyInside: true })).status === 401 && (await postPriv(postA, A, { onlyInside: true }, { extra: { origin: 'https://evil.example', host: 'localhost:3000' } })).status === 403)
      const tog = await postPriv(postA, A, { onlyInside: false })
      check('the ⋯ row on the moment post: 200, the row reads shown', tog.status === 200 && tog.wire.onlyInside === false && (await prisma.momentPrivacy.findUnique({ where: { sessionId_userId: { sessionId: sid, userId: A.id } } }))?.onlyInside === false)
      await postPriv(postA, A, { onlyInside: true })
      const kp = await postPriv(await postOf(K.id, sid), K, { onlyInside: true })
      check('a kicked author can still use the ⋯ row on their own post', kp.status === 200, kp)
      flags(true, false)
      check('Hide from Feed\'s flag off: hiddenFromFeed → 404, nothing charged; onlyInside still works', (await postPriv(hidCi, A, { hiddenFromFeed: false })).status === 404 && await noCharge('rl:post-privacy:*') && (await postPriv(postA, A, { onlyInside: true })).status === 200)
      flags(false, true)
      check('Moment Visibility\'s flag off: onlyInside → 404; hiddenFromFeed still works', (await postPriv(postA, A, { onlyInside: true })).status === 404 && (await postPriv(hidCi, A, { hiddenFromFeed: true })).status === 200)
      flags(false, false)
      const garbage = await postPriv(postA, A, 'not json at all')
      check('🔒 both flags off: a garbage body → the same 404 (not a 400), nothing charged', garbage.status === 404 && await noCharge('rl:post-privacy:*'), garbage.status)
      flags(true, true)
      // The feed's own-post fields.
      const own = await ofUser(A, A), mine = (id: number) => itemOf(own, id)
      check('the feed, your own posts: onlyInside + hiddenFromFeed on the moment post, hiddenFromFeed on each check-in', mine(postA)?.session?.onlyInside === true && mine(postA)?.session?.hiddenFromFeed === false && mine(hidCi)?.checkin?.hiddenFromFeed === true && mine(plainCi)?.checkin?.hiddenFromFeed === false, [mine(postA)?.session, mine(hidCi)?.checkin?.hiddenFromFeed])
      const mv = await ofUser(M, A)
      check('…never on someone else\'s', !('onlyInside' in (itemOf(mv, postA)?.session ?? {})) && !('hiddenFromFeed' in (itemOf(mv, postA)?.session ?? {})) && !('hiddenFromFeed' in (itemOf(mv, plainCi)?.checkin ?? {})))
      flags(false, false)
      const offOwn = await ofUser(A, A)
      check('…and only with their flags', !('onlyInside' in (itemOf(offOwn, postA)?.session ?? {})) && !('hiddenFromFeed' in (itemOf(offOwn, hidCi)?.checkin ?? {})))
      flags(true, true)
    }

    // ── § 25 i ───────────────────────────────────────────────────────────────
    section('§ 25 i a flag OFF with stored rows: every reader still hides (T1)')
    {
      flags(false, false)
      const u = await ofUser(S, A)
      check('?user=: the Only Inside post and the hidden check-in stay out', !ids(u).includes(postA) && !ids(u).includes(hidCi) && ids(u).includes(plainCi), ids(u))
      check('the web profile too', !webIds(await web(A, S)).includes(postA) && !webIds(await web(A, S)).includes(hidCi))
      const ki = ((await impressions(A, K)).wire.items as J[]).find(x => x.id === ratingA)
      check('Impressions stay stripped', !!ki && !('momentName' in ki) && !('wineId' in ki), ki)
      const ir = await impression(A, S, ratingA)
      check('the impression read stays stripped', ir.status === 200 && !('wineId' in ir.wire) && ir.wire.description === null)
      check('like and crave from the post stay 404', (await like(S, postA, 'POST')).status === 404 && (await crave(S, hidCi, 'POST')).status === 404)
      flags(true, true)
      const ce = await sqlErr(prisma.$executeRaw`UPDATE feed_items SET hidden_from_feed = true WHERE id = ${postA}`)
      check('🔒 the CHECK refuses hidden_from_feed on a moment post', !!ce && /feed_items_hidden_from_feed_standalone/.test(ce), ce)
    }

    // ── § 25 j ───────────────────────────────────────────────────────────────
    section('§ 25 j 1b\'s readers through the REAL write')
    {
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${sid}`
      const lk = await look(momentPid, S)
      const names = JSON.stringify(lk.wire)
      check('the look-in counts A and does not name them; the member is named', lk.status === 200 && !names.includes('Ada Author') && names.includes('Max Member'), lk.status)
      const ownList = await momentsOf(A, S), memList = await momentsOf(M, S)
      check('someone\'s Moments: A\'s open row is gone; M\'s is there', !((ownList.wire.items ?? []) as J[]).some(r => r.momentId === momentPid) && ((memList.wire.items ?? []) as J[]).some(r => r.momentId === momentPid), [ownList.wire.items, memList.wire.items])
      const facet = await momentsOf(M, S, `?people=u:${A.pid}`)
      check('the people facet on M\'s list misses A', ((facet.wire.items ?? []) as J[]).length === 0, facet.wire.items)
      const hostLine = async () => [itemOf(await ofUser(S, M), postM)?.session?.hostName, ((await web(M, S)).wire.recentSessionPosts as J[]).find(p => p.id === postM)?.hostName]
      const shownHost = await hostLine()
      await mePrivacy(code, H, { onlyInside: true })
      const hiddenHost = await hostLine()
      check('the feed and the web profile leave out a hidden host\'s line (shown before the write)', shownHost.every(x => x === 'Pia Host') && hiddenHost.every(x => x === null), [shownHost, hiddenHost])
      await mePrivacy(code, H, { onlyInside: false })
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends' WHERE id = ${sid}`
    }

    // ── § 25 k ───────────────────────────────────────────────────────────────
    section('§ 25 k viewerCanSeePost\'s line-up term on the like routes')
    {
      const HL = await mkUser('Lou Lineuphost')
      const cL = await createSession(HL, 'Lou Lineuphost')
      const T = await mkUser('Tia Taster'); await pub(T.id)
      await join(cL, T)
      const wl = await addWine(cL, HL, `${TAG} p3 k bottle`)
      await rate(cL, T, wl.id)
      const pT = await postOf(T.id, (await sessionOf(cL)).id)
      check('fixture: S likes the post while its line-up shows', (await like(S, pT, 'POST')).status === 200)
      await prisma.$executeRaw`UPDATE sessions SET hide_lineup = true, hide_lineup_minutes_before = 60, date_from = now() + interval '2 hours' WHERE code = ${cL}`
      check('🔒 like POST on a hidden line-up\'s post → 404', (await like(F, pT, 'POST')).status === 404)
      const ud = await like(S, pT, 'DELETE')
      check('like DELETE there (liked before): 200, no count', ud.status === 200 && ud.wire.liked === false && !('count' in ud.wire), ud)
      check('…and a 404 without a like of yours', (await like(F, pT, 'DELETE')).status === 404)
    }

    // ── § 25 l ───────────────────────────────────────────────────────────────
    section('§ 25 l the feed\'s network after a kick (Codex r1)')
    {
      const Hn = await mkUser('Nia Nethost'), V = await mkUser('Vic Kicked'), Ab = await mkUser('Abe Before'), Aa = await mkUser('Ali After')
      for (const u of [V, Ab, Aa]) await pub(u.id)
      const cN = await createSession(Hn, 'Nia Nethost')
      await join(cN, V); await join(cN, Ab)
      const cAb = await checkin(Ab, `${TAG} p3 l before`), cV = await checkin(V, `${TAG} p3 l kicked`)
      check('before the kick: a current buddy\'s check-in is in V\'s network', ids(await feed(V)).includes(cAb))
      await remove(cN, Hn, V, 'kick')
      await join(cN, Aa)
      const cAa = await checkin(Aa, `${TAG} p3 l after`)
      const nV = await feed(V)
      check('🔒 after the kick: neither a buddy from before nor one who joined after is in V\'s network', !ids(nV).includes(cAb) && !ids(nV).includes(cAa), ids(nV))
      check('🔒 …and the kicked buddy is not in the others\' network', !ids(await feed(Ab)).includes(cV) && !ids(await feed(Aa)).includes(cV))
      check('the others still have each other', ids(await feed(Aa)).includes(cAb))
    }

    // ── § 25 m ───────────────────────────────────────────────────────────────
    section('§ 25 m Hide from Feed on a moment post (R12): nobody but you, people in it included')
    {
      const Hq = await mkUser('Quinn Host'), Q = await mkUser('Quiet Quentin'), Gq = await mkUser('Gil Guestless')
      for (const u of [Hq, Q, Gq]) await pub(u.id)
      await mutual(Q.id, Gq.id)
      const cQ = await createSession(Hq, 'Quinn Host')
      await join(cQ, Q)
      const sQ = await sessionOf(cQ)
      const before = await mePrivacy(cQ, Q, { hiddenFromFeed: true })
      const row0 = (await prisma.$queryRaw`SELECT only_inside, hidden_from_feed FROM moment_privacy WHERE session_id = ${sQ.id} AND user_id = ${Q.id}` as J[])[0]
      check('the moment route takes { hiddenFromFeed } BEFORE any post exists (stored per moment), Incognito untouched', before.status === 200 && before.wire.hiddenFromFeed === true && row0?.hidden_from_feed === true && row0?.only_inside === false, [before.wire, row0])
      const wq = await addWine(cQ, Hq, `${TAG} P3 Quiet Bottle`)
      await rate(cQ, Q, wq.id)
      const qPost = await postOf(Q.id, sQ.id), qRating = await ratingOf(Q.id, sQ.id)
      const vis = (await visGet(cQ, Q)).wire.me
      check('the GET\'s me carries both choices and the moment\'s id', vis?.onlyInside === false && vis?.hiddenFromFeed === true && vis?.sessionId === sQ.id, vis)
      check('🔒 people IN the moment don\'t see the post: the host (?user= and network), a friend outside neither', !ids(await ofUser(Hq, Q)).includes(qPost) && !ids(await feed(Hq)).includes(qPost) && !ids(await ofUser(Gq, Q)).includes(qPost) && !ids(await feed(Gq)).includes(qPost))
      check('…nor the web profile (host, signed out)', !webIds(await web(Q, Hq)).includes(qPost) && !webIds(await web(Q, {})).includes(qPost))
      const own = itemOf(await ofUser(Q, Q), qPost)
      check('the author sees it, with hiddenFromFeed true and onlyInside false', !!own && own.session.hiddenFromFeed === true && own.session.onlyInside === false, own?.session)
      check('like / crave from the post → 404 for the host', (await like(Hq, qPost, 'POST')).status === 404 && (await crave(Hq, qPost, 'POST', { ratingId: qRating })).status === 404)
      const hImp = ((await impressions(Q, Hq)).wire.items as J[]).find(r => r.id === qRating), gImp = ((await impressions(Q, Gq)).wire.items as J[]).find(r => r.id === qRating)
      check('Impressions keep the row without its post; the moment\'s name stays (not Incognito)', hImp?.postId === null && !!hImp?.momentName && gImp?.postId === null && !!gImp?.momentName, [hImp, gImp])
      check('…and the impression page opens', (await impression(Q, Gq, qRating)).status === 200)
      const show = await postPriv(qPost, Q, { hiddenFromFeed: false })
      check('the ⋯ row shows it again (a moment post takes hiddenFromFeed now): 200, the host AND the friend outside see it (the control of the two "don\'t see" checks above)',
        show.status === 200 && show.wire.hiddenFromFeed === false && ids(await ofUser(Hq, Q)).includes(qPost) && ids(await ofUser(Gq, Q)).includes(qPost) && ids(await feed(Gq)).includes(qPost), show)
      const both = [await postPriv(qPost, Q, { hiddenFromFeed: true }), await postPriv(qPost, Q, { onlyInside: true })]
      const gImp2 = ((await impressions(Q, Gq)).wire.items as J[]).find(r => r.id === qRating)
      check('both on: nobody but the author sees the post; outsiders also get the row stripped (no moment name)', both.every(r => r.status === 200) && !ids(await ofUser(Hq, Q)).includes(qPost) && !('momentName' in (gImp2 ?? {})), gImp2)
      flags(true, false)
      check('Hide from Feed\'s flag off: the moment route\'s hiddenFromFeed → 404, the GET\'s me has no hiddenFromFeed; the post stays hidden (T1)',
        (await mePrivacy(cQ, Q, { hiddenFromFeed: false })).status === 404 && !('hiddenFromFeed' in ((await visGet(cQ, Q)).wire.me ?? {})) && !ids(await ofUser(Hq, Q)).includes(qPost))
      flags(true, true)
      const gq = await join(cQ, {}, 'Gary Guest')
      const gqr = await mePrivacy(cQ, { anon: gq.wire.anonToken }, { hiddenFromFeed: true })
      check('a guest can\'t (no posts): 400', gqr.status === 400, gqr.status)
      check('two fields at once → 400', (await mePrivacy(cQ, Q, { onlyInside: true, hiddenFromFeed: true })).status === 400)
    }

    // ── § 25 n ───────────────────────────────────────────────────────────────
    section('§ 25 n before / after a REAL follow: the plain posts and the look-in open, Incognito and Hide from Feed still hide, an unfollow closes again')
    {
      const Hn = await mkUser('Nia Host'), An = await mkUser('Ned Author'), V = await mkUser('Vic Viewer')
      for (const u of [Hn, V]) await pub(u.id)
      // Ned's posts are for his friends only, so a follow is what opens them.
      await prisma.user.update({ where: { id: An.id }, data: { profileVisibility: 'public-mutual', checkinVisibility: null } })
      const moment = async (label: string) => {
        const c = await createSession(Hn, 'Nia Host')
        await join(c, An)
        const w = await addWine(c, Hn, `${TAG} P3n ${label}`)
        await rate(c, An, w.id)
        const s = await sessionOf(c)
        return { code: c, pid: s.public_id, post: await postOf(An.id, s.id), rating: await ratingOf(An.id, s.id) }
      }
      const plain = await moment('Plain'), inc = await moment('Incognito'), hid = await moment('Hidden')
      check('fixture: Ned goes Incognito in one moment and hides his post of another from feeds (the real route)',
        (await mePrivacy(inc.code, An, { onlyInside: true })).status === 200 && (await mePrivacy(hid.code, An, { hiddenFromFeed: true })).status === 200)
      const ciPlain = await checkin(An, `${TAG} P3n Plain Checkin`), ciHid = await checkin(An, `${TAG} P3n Hidden Checkin`)
      check('fixture: Ned hides one check-in from feeds', (await postPriv(ciHid, An, { hiddenFromFeed: true })).status === 200)
      const all = [plain.post, inc.post, hid.post, ciPlain, ciHid]
      // Per post: [?user=, the network feed, the web profile].
      const seen = async () => {
        const u = await ofUser(V, An), n = await feed(V), w = await web(An, V)
        return all.map(p => [ids(u).includes(p), ids(n).includes(p), webIds(w).includes(p)])
      }
      const lookAll = async () => [(await look(plain.pid, V)).status, (await look(inc.pid, V)).status, (await look(hid.pid, V)).status]
      const T3 = [true, true, true], F3 = [false, false, false]
      const before = await seen(), lookBefore = await lookAll()
      check('before: Vic sees none of Ned\'s five posts (?user=, network, web profile)', JSON.stringify(before) === JSON.stringify([F3, F3, F3, F3, F3]), before)
      check('before: Vic can look into none of the three moments (Friends, people in it included: a create\'s default)', JSON.stringify(lookBefore) === '[404,404,404]', lookBefore)
      const f1 = await followOf(V, An), f2 = await followOf(An, V)
      check('Vic and Ned follow each other through POST /api/users/:id/follow', f1.status === 200 && f2.status === 200, [f1.status, f2.status])
      const after = await seen()
      check('🔒 friends now: the plain moment post and the plain check-in show everywhere; the Incognito post, the moment post hidden from feeds and the hidden check-in show nowhere',
        JSON.stringify(after) === JSON.stringify([T3, F3, F3, T3, F3]), after)
      const likes = [await like(V, plain.post, 'POST'), await like(V, inc.post, 'POST'), await like(V, hid.post, 'POST'), await like(V, ciHid, 'POST')].map(r => r.status)
      check('…like: the plain post 200; the Incognito post, the post hidden from feeds and the hidden check-in 404', JSON.stringify(likes) === '[200,404,404,404]', likes)
      const imp = ((await impressions(An, V)).wire.items ?? []) as J[]
      const impRow = (id: number) => imp.find(r => r.id === id)
      const [rP, rI, rH] = [impRow(plain.rating), impRow(inc.rating), impRow(hid.rating)]
      check('…Impressions: the plain row with its post; the Incognito row without the moment\'s name or its post; the hidden-from-feed row with the moment\'s name, no post',
        rP?.postId === plain.post && !!rP?.momentName && !!rI && rI.postId === null && !('momentName' in rI) && !!rH && rH.postId === null && !!rH.momentName, [rP, rI, rH])
      const lookAfter = await lookAll()
      check('🔒 the look-in: Vic looks in through Ned into the plain moment and the one whose post is hidden from feeds (Hide from Feed hides no taking part); the Incognito moment stays closed (Ned brings nobody in)',
        JSON.stringify(lookAfter) === '[200,404,200]', lookAfter)
      await join(inc.code, V, 'Vic')
      await join(hid.code, V, 'Vic')
      const inside = await ofUser(V, An)
      check('🔒 in the moment: Vic now sees the Incognito post; the post hidden from feeds still not (people in it included)', ids(inside).includes(inc.post) && !ids(inside).includes(hid.post), ids(inside))
      const u1 = await followOf(V, An, 'DELETE'), u2 = await followOf(An, V, 'DELETE')
      const gone = await ofUser(V, An), lookGone = (await look(plain.pid, V)).status
      check('an unfollow both ways (DELETE): the plain posts are gone again and the plain moment\'s look-in closes',
        u1.status === 200 && u2.status === 200 && !ids(gone).includes(plain.post) && !ids(gone).includes(ciPlain) && lookGone === 404, { u: [u1.status, u2.status], ids: ids(gone), lookGone })
    }

    // ── § 25 o ───────────────────────────────────────────────────────────────
    section('§ 25 o two concurrent "show again" requests: one change, ONE charge (R10, Codex 2026-11-25)')
    {
      const Ho = await mkUser('Ola Host'), R = await mkUser('Rio Racer')
      const co = await createSession(Ho, 'Ola Host')
      await join(co, R)
      const ci = await checkin(R, `${TAG} P3o Race Checkin`)
      const key = `rl:post-privacy:u:${R.id}:1h`
      check('fixture: the check-in hidden, and Hide from Feed on in the moment (both free)',
        (await postPriv(ci, R, { hiddenFromFeed: true })).status === 200 && (await mePrivacy(co, R, { hiddenFromFeed: true })).status === 200)
      await resetLimits()
      const twin = await Promise.all([postPriv(ci, R, { hiddenFromFeed: false }, { keep: true }), postPriv(ci, R, { hiddenFromFeed: false }, { keep: true })])
      check('🔒 the post route: both answer 200 { hiddenFromFeed: false }, the check-in is shown, ONE slot charged',
        twin.every(r => r.status === 200 && r.wire.hiddenFromFeed === false) && (await prisma.feedItem.findUniqueOrThrow({ where: { id: ci } })).hiddenFromFeed === false && (await rlCount(key)) === 1,
        { statuses: twin.map(r => r.status), charged: await rlCount(key) })
      await resetLimits()
      const pair = await Promise.all([0, 1].map(() => call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${co}/me/privacy`, R, { hiddenFromFeed: false }, { code: co })))
      const stored = (await prisma.$queryRaw`SELECT mp.hidden_from_feed FROM moment_privacy mp JOIN sessions s ON s.id = mp.session_id WHERE s.code = ${co} AND mp.user_id = ${R.id}` as J[])[0]
      check('🔒 the moment route: both 200, the choice is off, ONE slot charged (the write inside the contract changes it once)',
        pair.every(r => r.status === 200 && r.wire.hiddenFromFeed === false) && stored?.hidden_from_feed === false && (await rlCount(key)) === 1,
        { statuses: pair.map(r => r.status), stored, charged: await rlCount(key) })
      // A burst at the last slot (Codex recheck): three different hidden check-ins shown at once.
      const burst = [await checkin(R, `${TAG} P3o Burst A`), await checkin(R, `${TAG} P3o Burst B`), await checkin(R, `${TAG} P3o Burst C`)]
      for (const b of burst) await postPriv(b, R, { hiddenFromFeed: true })
      await resetLimits()
      await redis.set(key, '29', { EX: 3600 })
      const bres = await Promise.all(burst.map(b => postPriv(b, R, { hiddenFromFeed: false }, { keep: true })))
      const shownNow = (await prisma.feedItem.findMany({ where: { id: { in: burst } }, select: { hiddenFromFeed: true } })).filter(x => !x.hiddenFromFeed).length
      check('🔒 one slot left, three shows at once: exactly one goes through, two are refused (the slot is RESERVED before the write)',
        bres.filter(r => r.status === 200).length === 1 && bres.filter(r => r.status === 429).length === 2 && shownNow === 1, { statuses: bres.map(r => r.status), shownNow })
      await resetLimits()
      await redis.set(key, '30', { EX: 3600 })
      const spent = await postPriv(ci, R, { hiddenFromFeed: true }, { keep: true })
      const show = await postPriv(ci, R, { hiddenFromFeed: false }, { keep: true })
      check('a spent budget: hiding still works (R10), showing again → 429 and nothing written', spent.status === 200 && show.status === 429 && (await prisma.feedItem.findUniqueOrThrow({ where: { id: ci } })).hiddenFromFeed === true, [spent.status, show.status])
      await resetLimits()
    }

    // ── after the moment's deletion: the author only ────────────────────────
    section('§ 25 b (end) after the moment\'s deletion, an Only Inside post shows to its author only')
    {
      await resetLimits()
      const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, H, undefined, { code })
      check('fixture: the host deletes the moment', del.status === 200, del.status)
      check('the member no longer sees it; the author does', !ids(await ofUser(M, A)).includes(postA) && ids(await ofUser(A, A)).includes(postA))
      const dp = await postPriv(postA, A, { onlyInside: false })
      check('the ⋯ row works on a deleted moment', dp.status === 200)
      check('…and then everyone who may see A\'s posts sees it again', ids(await ofUser(M, A)).includes(postA) && ids(await ofUser(S, A)).includes(postA))
      await postPriv(postA, A, { onlyInside: true })
    }
  } finally {
    if (saved.mv === undefined) delete process.env.MOMENT_LOOKIN_ENABLED; else process.env.MOMENT_LOOKIN_ENABLED = saved.mv
    if (saved.hff === undefined) delete process.env.HIDE_FROM_FEED_ENABLED; else process.env.HIDE_FROM_FEED_ENABLED = saved.hff
    if (saved.secret === undefined) delete process.env.MOMENT_LINK_SECRET; else process.env.MOMENT_LINK_SECRET = saved.secret
  }
  void follows
}
