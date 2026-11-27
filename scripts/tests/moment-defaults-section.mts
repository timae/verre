// § 27 Moment Defaults (docs/dev/proposals/moment-defaults.md; the build plan
// .local/moment-visibility/moment-defaults-plan.md § 7). Imported by
// scripts/tests/you-profile-integration.mts after § 26, with the same harness:
// every response through `call` passes the integer canary.
//   § 27 a seeding per writer (create, /join, /visit, /rate, promotion) and
//          every writer that must NOT seed (set-role, kick-keep, promotion's
//          kicked rows, a legacy rating author, a legacy strict host, a kicked
//          rater re-admitted); a kick-keep placeholder seeded on its first
//          /join; a hand-set row kept over a ban and a rejoin; copied, never live
//   § 27 b the check-in POST's hiddenFromFeed (absent, false, 400, a replay,
//          Had a sip, a photo PATCH)
//   § 27 c the routes; the preview by direction; the apply: K6 both ways, the
//          scope of each section, the STORED default, the races under the
//          locks, the lock timeout, the Redis deadlines, account deletion's
//          lock order, the budgets, the request limiter, the flags
//   § 27 d account deletion cascades; SYSTEM_DEFAULTS = the column defaults
//   § 27 e the membership-write census and its self-test
import { nanoid } from 'nanoid'
import { execFileSync } from 'node:child_process'
import type { MomentVisibilityHarness } from './moment-visibility-section.mts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Priv = { only_inside: boolean; hidden_from_feed: boolean } | null

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function momentDefaults(h: MomentVisibilityHarness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, TAG } = h
  const sessionRoute = await import('../../app/api/session/route.ts')
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const unbanRoute = await import('../../app/api/session/[code]/bans/[identityId]/route.ts')
  const mePrivacyRoute = await import('../../app/api/session/[code]/me/privacy/route.ts')
  const checkinsRoute = await import('../../app/api/checkins/route.ts')
  const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
  const defaultsRoute = await import('../../app/api/me/moment-defaults/route.ts')
  const applyRoute = await import('../../app/api/me/moment-defaults/apply/route.ts')
  const { mutationHooks } = await import('../../lib/sessionMutation.ts')
  const { momentDefaultsSeams, SYSTEM_DEFAULTS, applySectionKey, applyItemKey, applyRequestKey, REDIS_DEADLINE_MS, LOCK_TIMEOUT_MS, previewDefault } = await import('../../lib/momentDefaults.ts')
  const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')

  const saved = { mv: process.env.MOMENT_LOOKIN_ENABLED, hff: process.env.HIDE_FROM_FEED_ENABLED }
  const flags = (mv: boolean, hff: boolean) => {
    if (mv) process.env.MOMENT_LOOKIN_ENABLED = 'true'; else delete process.env.MOMENT_LOOKIN_ENABLED
    if (hff) process.env.HIDE_FROM_FEED_ENABLED = 'true'; else delete process.env.HIDE_FROM_FEED_ENABLED
  }
  const noHooks = () => { mutationHooks.at = async () => {}; momentDefaultsSeams.redis = async () => {}; momentDefaultsSeams.afterParentLocks = async () => {} }
  flags(true, true)

  // ── helpers ────────────────────────────────────────────────────────────────
  const dateFrom = new Date(Date.now() + 3600_000).toISOString()
  const create = async (u: Actor, privacy?: unknown, extra: J = {}) => {
    await resetLimits()
    return call(sessionRoute.POST, 'POST', '/api/session', u, { hostDisplayName: 'Defaults Host', sessionName: `${TAG} md moment`, dateFrom, ...(privacy === undefined ? {} : { privacy }), ...extra })
  }
  const createOk = async (u: Actor, privacy?: unknown) => {
    const r = await create(u, privacy)
    if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
    return r.json.code as string
  }
  const join = async (code: string, a: Actor, name = 'Joiner') => {
    await resetLimits()
    const r = await call(joinRoute.POST, 'POST', '/api/session/join', a, { code, displayName: name })
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
    return r
  }
  const visit = async (code: string, a: Actor) => {
    await resetLimits()
    const r = await call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, a, undefined, { code })
    if (r.status !== 200) throw new Error(`visit failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const rate = async (code: string, a: Actor, wineId: string) => {
    await resetLimits()
    const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, a, { wineId, score: 4, flavors: { body: 3 }, notes: 'md note' }, { code })
    if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const remove = async (code: string, host: Actor, target: User, mode: 'kick' | 'ban') => {
    await resetLimits()
    const r = await call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, host, { identityId: `u:${target.pid}`, mode }, { code })
    if (r.status !== 200) throw new Error(`${mode} failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const unban = async (code: string, host: Actor, target: User) => {
    await resetLimits()
    const id = `u:${target.pid}`
    const r = await call(unbanRoute.DELETE, 'DELETE', `/api/session/${code}/bans/${encodeURIComponent(id)}`, host, undefined, { code, identityId: id })
    if (r.status !== 200) throw new Error(`unban failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const setRole = async (code: string, by: Actor, target: User, role: string) => {
    await resetLimits()
    const r = await call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, by, { action: 'set-role', targetId: `u:${target.pid}`, role }, { code })
    if (r.status !== 200) throw new Error(`set-role failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const mePrivacy = async (code: string, a: Actor, body: unknown) => {
    await resetLimits()
    const r = await call(mePrivacyRoute.PATCH, 'PATCH', `/api/session/${code}/me/privacy`, a, body, { code })
    if (r.status !== 200) throw new Error(`me/privacy failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const sid = async (code: string) => Number((await prisma.$queryRaw`SELECT id FROM sessions WHERE code = ${code} AND deleted_at IS NULL` as J[])[0]?.id)
  const priv = async (sessionId: number, userId: number): Promise<Priv> =>
    ((await prisma.$queryRaw`SELECT only_inside, hidden_from_feed FROM moment_privacy WHERE session_id = ${sessionId} AND user_id = ${userId}` as J[])[0] as Priv) ?? null
  const cols = async (code: string) => (await prisma.$queryRaw`
    SELECT visibility, include_guest_circles AS circles, show_place AS place, show_details AS details FROM sessions WHERE code = ${code}` as J[])[0]
  const colsById = async (id: number) => (await prisma.$queryRaw`
    SELECT visibility, include_guest_circles AS circles, show_place AS place, show_details AS details FROM sessions WHERE id = ${id}` as J[])[0]
  const setDefaults = async (u: User, d: J) => {
    const c = { visibility: null, include_guest_circles: null, show_place: null, show_details: null, only_inside: null, moment_hidden_from_feed: null, checkin_hidden_from_feed: null, ...d }
    await prisma.$executeRaw`
      INSERT INTO moment_defaults (user_id, visibility, include_guest_circles, show_place, show_details, only_inside, moment_hidden_from_feed, checkin_hidden_from_feed)
      VALUES (${u.id}, ${c.visibility}, ${c.include_guest_circles}, ${c.show_place}, ${c.show_details}, ${c.only_inside}, ${c.moment_hidden_from_feed}, ${c.checkin_hidden_from_feed})
      ON CONFLICT (user_id) DO UPDATE SET visibility = EXCLUDED.visibility, include_guest_circles = EXCLUDED.include_guest_circles,
        show_place = EXCLUDED.show_place, show_details = EXCLUDED.show_details, only_inside = EXCLUDED.only_inside,
        moment_hidden_from_feed = EXCLUDED.moment_hidden_from_feed, checkin_hidden_from_feed = EXCLUDED.checkin_hidden_from_feed`
  }
  const getDefaults = async (a: Actor) => { await resetLimits(); return call(defaultsRoute.GET, 'GET', '/api/me/moment-defaults', a) }
  const patchDefault = async (a: Actor, body: unknown, o: { keep?: boolean; extra?: Record<string, string> } = {}) => {
    if (!o.keep) await resetLimits()
    return call(defaultsRoute.PATCH, 'PATCH', '/api/me/moment-defaults', a, body, {}, o.extra ?? {})
  }
  const apply = async (a: Actor, body: unknown, o: { keep?: boolean; extra?: Record<string, string> } = {}) => {
    if (!o.keep) await resetLimits()
    return call(applyRoute.POST, 'POST', '/api/me/moment-defaults/apply', a, body, {}, o.extra ?? {})
  }
  const count = async (key: string) => Number((await redis.get(key)) ?? 0)
  const checkinPost = async (u: User, extra: J = {}) => {
    await resetLimits()
    return call(checkinsRoute.POST, 'POST', '/api/checkins', u, { occurrenceId: nanoid(), wineName: `${TAG} md bottle`, score: 3.5, flavors: { body: 2 }, notes: 'md', ...extra })
  }
  const fiHidden = async (id: number) => (await prisma.$queryRaw`SELECT hidden_from_feed AS h FROM feed_items WHERE id = ${id}` as J[])[0]?.h as boolean
  const rawRating = async (sessionId: number, userId: number, wineId: string) => prisma.$executeRaw`
    INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, rated_at, mirror_at)
    VALUES (${wineId}, ${userId}, ${sessionId}, 'session', 'Legacy', 3, '{}'::jsonb, NOW(), clock_timestamp())`

  try {
    // ── § 27 a seeding per writer ──────────────────────────────────────────
    section('§ 27 a Moment Defaults: copied when participation STARTS, by the three ENTRY writers only')
    const A = await mkUser('MD Ana')
    // A create with every field present (false included).
    const cAll = await createOk(A, { visibility: 'members', includeGuestCircles: false, showPlace: true, showDetails: true, onlyInside: true, hiddenFromFeed: false })
    check('create, privacy present: the four host settings are the body\'s', JSON.stringify(await cols(cAll)) === JSON.stringify({ visibility: 'members', circles: false, place: true, details: true }), await cols(cAll))
    check('🔒 create, privacy.onlyInside true with NO defaults row: the host\'s row is written (review r1 P1)', JSON.stringify(await priv(await sid(cAll), A.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: false }), await priv(await sid(cAll), A.id))
    const cNone = await createOk(A)
    check('create, no privacy, no defaults: the system defaults (Friends, circles on, place + details hidden), no privacy row',
      JSON.stringify(await cols(cNone)) === JSON.stringify({ visibility: 'friends', circles: true, place: false, details: false }) && (await priv(await sid(cNone), A.id)) === null, await cols(cNone))
    await setDefaults(A, { visibility: 'followers', include_guest_circles: false, show_place: true, only_inside: true, moment_hidden_from_feed: true })
    const cDef = await createOk(A)
    check('create, privacy absent: the host\'s defaults (the web sends none: D7)', JSON.stringify(await cols(cDef)) === JSON.stringify({ visibility: 'followers', circles: false, place: true, details: false }), await cols(cDef))
    check('create, privacy absent: the host\'s own Incognito + Hide from Feed copied', JSON.stringify(await priv(await sid(cDef), A.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: true }), await priv(await sid(cDef), A.id))
    const cMix = await createOk(A, { visibility: 'verre', onlyInside: false, hiddenFromFeed: false })
    check('🔒 create, mixed: a field present wins (false included), an absent one is the default',
      JSON.stringify(await cols(cMix)) === JSON.stringify({ visibility: 'verre', circles: false, place: true, details: false }) && (await priv(await sid(cMix), A.id)) === null, { cols: await cols(cMix), priv: await priv(await sid(cMix), A.id) })
    const bad1 = await create(A, { visibility: 'everyone' })
    const bad2 = await create(A, { onlyInside: 'yes' })
    const bad3 = await create(A, 'members')
    check('create: an ill-typed privacy is a 400 (before the cover upload)', bad1.status === 400 && bad2.status === 400 && bad3.status === 400, [bad1.status, bad2.status, bad3.status])
    // A guest create: privacy ignored; the moment stays closed at promotion.
    await resetLimits()
    const g = await call(sessionRoute.POST, 'POST', '/api/session', {}, { hostDisplayName: 'Guest Host', sessionName: `${TAG} md guest`, dateFrom, privacy: { visibility: 'verre', onlyInside: true } })
    const gCode = g.json.code as string
    const G: Actor = { anon: g.json.anonToken as string }
    check('a guest create with privacy: 200, no record yet', g.status === 200 && !(await sid(gCode)), g.status)
    // Promotion: three roster people, each with their own defaults; a kicked one.
    const P1 = await mkUser('MD P1'); await setDefaults(P1, { only_inside: true })
    const P2 = await mkUser('MD P2'); await setDefaults(P2, { moment_hidden_from_feed: true })
    const P3 = await mkUser('MD P3'); await setDefaults(P3, { visibility: 'verre', only_inside: false, moment_hidden_from_feed: false })
    const P4 = await mkUser('MD P4'); await setDefaults(P4, { only_inside: true })
    for (const p of [P1, P2, P3, P4]) await join(gCode, p)
    check('fixture: signed-in joins of a guest moment write nothing durable', !(await sid(gCode)))
    await resetLimits()
    const kick4 = await call(bansRoute.POST, 'POST', `/api/session/${gCode}/bans`, G, { identityId: `u:${P4.pid}`, mode: 'kick' }, { code: gCode })
    check('fixture: the guest host kicks P4 (Redis-only)', kick4.status === 200, kick4.json)
    await visit(gCode, P3) // P3 (whose defaults are all off / verre) promotes
    const gSid = await sid(gCode)
    const pm = await prisma.$queryRaw`SELECT user_id, removed_state FROM session_members WHERE session_code = ${gCode} ORDER BY user_id` as J[]
    check('fixture: promotion wrote the roster\'s member rows (P4 kicked)', gSid > 0 && pm.length === 4 && pm.find(r => Number(r.user_id) === P4.id)?.removed_state === 'kicked', pm)
    check('🔒 promotion: EACH person\'s own defaults (P1 Incognito, P2 Hide from Feed), never the promoter\'s',
      JSON.stringify(await priv(gSid, P1.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: false })
      && JSON.stringify(await priv(gSid, P2.id)) === JSON.stringify({ only_inside: false, hidden_from_feed: true })
      && (await priv(gSid, P3.id)) === null, { p1: await priv(gSid, P1.id), p2: await priv(gSid, P2.id), p3: await priv(gSid, P3.id) })
    check('🔒 promotion: a row inserted KICKED does not seed (a possible placeholder)', (await priv(gSid, P4.id)) === null, await priv(gSid, P4.id))
    check('🔒 promotion: no host settings (a guest-hosted moment stays Only People Who Joined, whatever the promoter\'s default)', (await cols(gCode)).visibility === 'members', await cols(gCode))
    // /join, /visit, /rate as the first entry.
    const H = await mkUser('MD Host')
    const M = await createSession(H)
    const w = await addWine(M, H, `${TAG} md wine`)
    const mSid = await sid(M)
    const J1 = await mkUser('MD J1'); await setDefaults(J1, { only_inside: true })
    const V1 = await mkUser('MD V1'); await setDefaults(V1, { moment_hidden_from_feed: true })
    const R1 = await mkUser('MD R1'); await setDefaults(R1, { only_inside: true, moment_hidden_from_feed: true })
    await join(M, J1)
    check('first /join: seeded', JSON.stringify(await priv(mSid, J1.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: false }), await priv(mSid, J1.id))
    await visit(M, V1)
    check('first /visit: seeded', JSON.stringify(await priv(mSid, V1.id)) === JSON.stringify({ only_inside: false, hidden_from_feed: true }), await priv(mSid, V1.id))
    // /rate inserts a member row only for someone the record admits without
    // one (a legacy rating author): its insert comes BEFORE the rating upsert,
    // so K1's rating guard sees the old rating and copies nothing.
    const w2 = await addWine(M, H, `${TAG} md wine 2`)
    await rawRating(mSid, R1.id, w.id)
    await rate(M, R1, w2.id)
    const r1m = await prisma.$queryRaw`SELECT 1 FROM session_members WHERE session_code = ${M} AND user_id = ${R1.id}` as J[]
    check('🔒 /rate by a legacy rating author: the member row is written (before the upsert), nothing copied', r1m.length === 1 && (await priv(mSid, R1.id)) === null, await priv(mSid, R1.id))
    // NOT ENTRY: set-role on a legacy rating author; their later /visit.
    const L1 = await mkUser('MD Legacy rater'); await setDefaults(L1, { only_inside: true })
    await rawRating(mSid, L1.id, w.id)
    await setRole(M, H, L1, 'provider')
    check('🔒 set-role\'s insert (a legacy rating author, now provider) does not seed', (await priv(mSid, L1.id)) === null, await priv(mSid, L1.id))
    const L2 = await mkUser('MD Legacy rater 2'); await setDefaults(L2, { only_inside: true })
    await rawRating(mSid, L2.id, w.id)
    await visit(M, L2)
    const l2m = await prisma.$queryRaw`SELECT 1 FROM session_members WHERE session_code = ${M} AND user_id = ${L2.id}` as J[]
    check('🔒 a legacy rating author\'s first /visit: the member row is written, nothing copied (grandfathered: K1)', l2m.length === 1 && (await priv(mSid, L2.id)) === null, await priv(mSid, L2.id))
    // A legacy strict host: no member row, defaults set later.
    const LH = await mkUser('MD Legacy host')
    const LM = await createSession(LH)
    const lmSid = await sid(LM)
    await prisma.$executeRaw`DELETE FROM session_members WHERE session_code = ${LM}`
    await setDefaults(LH, { only_inside: true })
    await visit(LM, LH)
    check('🔒 a legacy strict host\'s first /visit: member row back, nothing copied', (await priv(lmSid, LH.id)) === null)
    // kick-keep placeholder for someone who never joined; then their first /join.
    const KP = await mkUser('MD Placeholder'); await setDefaults(KP, { only_inside: true })
    await remove(M, H, KP, 'kick')
    const kpRow = await prisma.$queryRaw`SELECT removed_state FROM session_members WHERE session_code = ${M} AND user_id = ${KP.id}` as J[]
    check('🔒 kick-keep\'s insert (a placeholder for an account that never joined) does not seed', kpRow[0]?.removed_state === 'kicked' && (await priv(mSid, KP.id)) === null, kpRow)
    await join(M, KP)
    check('🔒 …their first /join clears the kick and copies the default (Codex r1 P1)', JSON.stringify(await priv(mSid, KP.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: false }), await priv(mSid, KP.id))
    // A kicked member who RATED, re-admitted: no seed.
    const KR = await mkUser('MD Kicked rater')
    await join(M, KR)
    await rate(M, KR, w.id)
    await remove(M, H, KR, 'kick')
    await setDefaults(KR, { only_inside: true })
    await join(M, KR)
    check('🔒 a kicked member who rated, re-admitted: nothing copied (their post exists)', (await priv(mSid, KR.id)) === null, await priv(mSid, KR.id))
    // ban → unban → rejoin keeps a hand-set row.
    const HB = await mkUser('MD Hand-set')
    await join(M, HB)
    await mePrivacy(M, HB, { onlyInside: true })
    await setDefaults(HB, { only_inside: false, moment_hidden_from_feed: true })
    await remove(M, H, HB, 'ban')
    await unban(M, H, HB)
    await join(M, HB)
    check('🔒 ban → unban → rejoin keeps the hand-set row (the default never writes over it)', JSON.stringify(await priv(mSid, HB.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: false }), await priv(mSid, HB.id))
    // Copied, never live.
    const CL = await mkUser('MD Copied')
    await join(M, CL)
    await resetLimits()
    const pCL = await patchDefault(CL, { onlyInside: true })
    check('🔒 a default changed later changes no existing membership', pCL.status === 200 && (await priv(mSid, CL.id)) === null, pCL.status)
    // Flags off: copying never checks a flag (§ 2.5).
    flags(false, false)
    const FF = await mkUser('MD Flags off'); await setDefaults(FF, { only_inside: true, moment_hidden_from_feed: true })
    const cFF = await createOk(FF)
    await join(M, FF)
    check('🔒 with both flags OFF the create and the join still copy', JSON.stringify(await priv(await sid(cFF), FF.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: true })
      && JSON.stringify(await priv(mSid, FF.id)) === JSON.stringify({ only_inside: true, hidden_from_feed: true }))
    flags(true, true)

    // ── § 27 b the check-in POST ───────────────────────────────────────────
    section('§ 27 b the check-in POST: hiddenFromFeed present = this check-in\'s, absent = your check-in default')
    const C = await mkUser('MD Checker')
    const ci0 = await checkinPost(C)
    check('absent, no defaults: shown', ci0.status === 201 && (await fiHidden(ci0.json.id)) === false, ci0.status)
    await setDefaults(C, { checkin_hidden_from_feed: true })
    const ci1 = await checkinPost(C)
    check('absent, default on: hidden', ci1.status === 201 && (await fiHidden(ci1.json.id)) === true)
    const ci2 = await checkinPost(C, { hiddenFromFeed: false })
    check('🔒 false against a default on: false (a field present is this check-in\'s choice)', ci2.status === 201 && (await fiHidden(ci2.json.id)) === false)
    const ci3 = await checkinPost(C, { hiddenFromFeed: 'yes' })
    check('a non-boolean: 400', ci3.status === 400, ci3.status)
    const occ = nanoid()
    await resetLimits()
    const first = await call(checkinsRoute.POST, 'POST', '/api/checkins', C, { occurrenceId: occ, wineName: `${TAG} md replay`, score: 3, flavors: {} })
    await setDefaults(C, { checkin_hidden_from_feed: false })
    await resetLimits()
    const again = await call(checkinsRoute.POST, 'POST', '/api/checkins', C, { occurrenceId: occ, wineName: `${TAG} md replay`, score: 3, flavors: {} })
    check('🔒 a replay after the default changed answers the STORED check-in (still hidden)', first.status === 201 && again.status === 200 && again.json.id === first.json.id && (await fiHidden(first.json.id)) === true, [first.status, again.status])
    await setDefaults(C, { checkin_hidden_from_feed: true })
    // Had a sip (D8): a public source C follows.
    const S = await mkUser('MD Source')
    await prisma.user.update({ where: { id: S.id }, data: { profileVisibility: 'public-internet', checkinVisibility: null } })
    await prisma.follow.createMany({ data: [{ followerId: C.id, followingId: S.id }], skipDuplicates: true })
    const src = await checkinPost(S)
    const sip = await checkinPost(C, { copyFromCheckinId: src.json.id })
    check('Had a sip gets the check-in default (D8)', src.status === 201 && sip.status === 201 && (await fiHidden(sip.json.id)) === true, [src.status, sip.status, sip.json])
    await setDefaults(C, { checkin_hidden_from_feed: false })
    await resetLimits()
    const ph = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${ci1.json.id}`, C, { imageData: PNG }, { id: String(ci1.json.id) })
    check('a photo PATCH never re-applies a default', ph.status === 200 && (await fiHidden(ci1.json.id)) === true, ph.status)

    // ── § 27 c the routes, the preview, the apply ──────────────────────────
    section('§ 27 c the routes: signed in, same origin, one field, private no-store')
    const R = await mkUser('MD Routes')
    const out401 = [await getDefaults({}), await patchDefault({}, { onlyInside: true }), await apply({}, { field: 'onlyInside' })]
    check('signed out: 401 on all three', out401.every(r => r.status === 401), out401.map(r => r.status))
    const cross = [await patchDefault(R, { onlyInside: true }, { extra: { origin: 'https://evil.example' } }), await apply(R, { field: 'onlyInside' }, { extra: { origin: 'https://evil.example' } })]
    check('cross-origin: 403 on the PATCH and the apply', cross.every(r => r.status === 403), cross.map(r => r.status))
    const g0 = await getDefaults(R)
    check('GET: the seven resolved values = the system defaults', g0.status === 200 && JSON.stringify(g0.json) === JSON.stringify(SYSTEM_DEFAULTS), g0.json)
    const bads = [await patchDefault(R, {}), await patchDefault(R, { onlyInside: true, showPlace: true }), await patchDefault(R, { nope: true }), await patchDefault(R, { visibility: 'everyone' }), await patchDefault(R, { showPlace: 'no' }),
      await apply(R, {}), await apply(R, { field: 'nope' }), await apply(R, { field: 'visibility', value: 'verre' }), await apply(R, { field: '__proto__' })]
    check('PATCH / apply: anything but exactly one known field of its type is a 400 (a body value never reaches the apply)', bads.every(r => r.status === 400), bads.map(r => r.status))
    const all = [g0, ...out401, ...cross, ...bads, await patchDefault(R, { showPlace: true })]
    check('🔒 Cache-Control: private, no-store on every return path seen', all.every(r => r.headers.get('cache-control') === 'private, no-store'), all.map(r => r.headers.get('cache-control')))
    await resetLimits()
    await patchDefault(R, { visibility: 'verre' }, { keep: true })
    const ch1 = await count(`rl:moment-defaults:u:${R.id}:1h`)
    await patchDefault(R, { visibility: 'verre' }, { keep: true })
    check('PATCH: charged on a change that widens, a no-op is free', ch1 === 1 && (await count(`rl:moment-defaults:u:${R.id}:1h`)) === 1, ch1)
    await redis.set(`rl:moment-defaults:u:${R.id}:1h`, '60', { EX: 3600 })
    const spent = await patchDefault(R, { showDetails: true }, { keep: true })
    check('PATCH: 60/h, the 61st change that WIDENS is a 429 and writes nothing', spent.status === 429 && (await getDefaults(R)).json.showDetails === false, spent.status)
    await redis.set(`rl:moment-defaults:u:${R.id}:1h`, '60', { EX: 3600 })
    const narrow = await patchDefault(R, { onlyInside: true }, { keep: true })
    const back = await patchDefault(R, { visibility: 'members' }, { keep: true })
    const afterNarrow = await count(`rl:moment-defaults:u:${R.id}:1h`)
    const dn = (await getDefaults(R)).json
    check('🔒 …a change that makes a default MORE private is never charged or refused (R10: the alert\'s Cancel undoing a widening always lands, Codex build r9)',
      narrow.status === 200 && back.status === 200 && dn.onlyInside === true && dn.visibility === 'members' && afterNarrow === 60,
      [narrow.status, back.status, afterNarrow])

    section('§ 27 c the preview (counts by direction) and the host apply')
    const H1 = await mkUser('MD Host 1')
    const OH = await mkUser('MD Other host')
    const h1a = await createOk(H1, { visibility: 'members' })
    const h1b = await createOk(H1, { visibility: 'friends' })
    const h1c = await createOk(H1, { visibility: 'verre' })
    const h1del = await createOk(H1, { visibility: 'members' })
    await resetLimits()
    const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${h1del}`, H1, undefined, { code: h1del })
    const coh = await createOk(OH, { visibility: 'members' })
    await join(coh, H1)
    await setRole(coh, OH, H1, 'co_host')
    const pv = await patchDefault(H1, { visibility: 'followers' })
    check('fixture: a deleted moment of H1, a moment H1 only cohosts', del.status === 200)
    check('PATCH answers `existing`: Visible To mixes (2 wider, 1 narrower); cohosted and deleted excluded (D9)',
      pv.status === 200 && JSON.stringify(pv.json.existing) === JSON.stringify({ field: 'visibility', value: 'followers', count: 3, wider: 2, narrower: 1 }), pv.json)
    await resetLimits()
    const ap = await apply(H1, { field: 'visibility' }, { keep: true })
    check('apply: every hosted moment that differed is now the stored default', ap.status === 200 && ap.json.changed === 3
      && (await cols(h1a)).visibility === 'followers' && (await cols(h1b)).visibility === 'followers' && (await cols(h1c)).visibility === 'followers', ap.json)
    check('🔒 a moment you only cohost is never touched (D9)', (await cols(coh)).visibility === 'members')
    check('budget: a widening action = ONE slot on the bulk key AND one change on rl:moment-visibility; the request limiter not charged (it changed something)',
      (await count(applySectionKey(H1.id, 'host').key)) === 1 && (await count(applyItemKey(H1.id, 'host').key)) === 1 && (await count(applyRequestKey(H1.id).key)) === 0,
      [await count(applySectionKey(H1.id, 'host').key), await count(applyItemKey(H1.id, 'host').key), await count(applyRequestKey(H1.id).key)])
    const pv2 = await patchDefault(H1, { visibility: 'followers' }, { keep: true })
    const pvNone = await previewDefault(prisma, H1.id, 'visibility', 'followers')
    const ap2 = await apply(H1, { field: 'visibility' }, { keep: true })
    check('nothing differs: the preview is null (a no-op PATCH answers null without one), the apply changes nothing, costs no bulk slot, and charges the request limiter once',
      pvNone === null && pv2.json.existing === null && ap2.status === 200 && ap2.json.changed === 0 && (await count(applySectionKey(H1.id, 'host').key)) === 1 && (await count(applyRequestKey(H1.id).key)) === 1, [pvNone, pv2.json, ap2.json])
    // K6
    const H2 = await mkUser('MD Host 2')
    const k6a = await createOk(H2, { visibility: 'friends', includeGuestCircles: false })
    const k6b = await createOk(H2, { visibility: 'members', includeGuestCircles: false })
    const k6c = await createOk(H2, { visibility: 'followers', includeGuestCircles: true })
    await setDefaults(H2, { include_guest_circles: false })
    const k1 = await patchDefault(H2, { includeGuestCircles: true })
    check('K6 widening: counted only where Visible To is Friends / Followers', JSON.stringify(k1.json.existing) === JSON.stringify({ field: 'includeGuestCircles', value: true, count: 1, wider: 1, narrower: 0 }), k1.json.existing)
    const k1a = await apply(H2, { field: 'includeGuestCircles' })
    check('K6 widening: turned on only there (Only People Who Joined left off)', k1a.json.changed === 1 && (await cols(k6a)).circles === true && (await cols(k6b)).circles === false, k1a.json)
    // K6 decided again under the lock: a moment scanned as Friends (circles
    // off) that moved to Only People Who Joined before its lock is not widened.
    const k6d = await createOk(H2, { visibility: 'friends', includeGuestCircles: false })
    await setDefaults(H2, { include_guest_circles: true })
    mutationHooks.at = async (point, code, label) => {
      if (point === 'beforeLock' && label === 'moment-defaults-apply' && code === k6d) await prisma.$executeRaw`UPDATE sessions SET visibility = 'members' WHERE code = ${k6d}`
    }
    const k1d = await apply(H2, { field: 'includeGuestCircles' })
    noHooks()
    check('🔒 K6 from the LOCKED row: moved to Only People Who Joined after the scan → its circles switch is not turned on', k1d.status === 200 && (await cols(k6d)).circles === false, [k1d.json, await cols(k6d)])
    await prisma.$executeRaw`UPDATE sessions SET include_guest_circles = true WHERE code = ${k6b}`
    const k2 = await patchDefault(H2, { includeGuestCircles: false })
    check('🔒 K6 narrowing: counts EVERY hosted moment where it is on, Visible To aside', JSON.stringify(k2.json.existing) === JSON.stringify({ field: 'includeGuestCircles', value: false, count: 3, wider: 0, narrower: 3 }), k2.json.existing)
    const k2a = await apply(H2, { field: 'includeGuestCircles' })
    check('🔒 K6 narrowing: all three off, the one on Only People Who Joined included', k2a.json.changed === 3 && [k6a, k6b, k6c].every(Boolean) && (await cols(k6a)).circles === false && (await cols(k6b)).circles === false && (await cols(k6c)).circles === false, k2a.json)
    const H3 = await mkUser('MD Host 3')
    const three = [await createOk(H3, { visibility: 'members' }), await createOk(H3, { visibility: 'members' }), await createOk(H3, { visibility: 'members' })]
    const k3 = await patchDefault(H3, { includeGuestCircles: false })
    const k3a = await apply(H3, { field: 'includeGuestCircles' })
    check('🔒 no Friends / Followers moment, three on Only People Who Joined with circles on: narrower = 3, all three changed (review r2 P2)',
      k3.json.existing?.narrower === 3 && k3a.json.changed === 3 && (await Promise.all(three.map(cols))).every(x => x.circles === false), [k3.json.existing, k3a.json])
    // The races under the locks.
    section('§ 27 c the host apply decides under each moment\'s locks')
    const H4 = await mkUser('MD Host 4')
    const Z4 = await mkUser('MD New host')
    const lost = await createOk(H4, { visibility: 'members' })
    const kept = await createOk(H4, { visibility: 'members' })
    await setDefaults(H4, { visibility: 'friends' })
    mutationHooks.at = async (point, code, label) => {
      if (point === 'beforeLock' && label === 'moment-defaults-apply' && code === lost) await prisma.$executeRaw`UPDATE sessions SET host_user_id = ${Z4.id} WHERE code = ${lost}`
    }
    const r4 = await apply(H4, { field: 'visibility' })
    noHooks()
    check('🔒 a moment that lost its host between the scan and its lock is not written (the strict host by the fresh grant, under the lock)',
      r4.status === 200 && (await cols(lost)).visibility === 'members' && (await cols(kept)).visibility === 'friends', [r4.json, await cols(lost)])
    // The code reused between the scan and the lock (codes recycle): the id binds.
    const H4b = await mkUser('MD Host 4b')
    const reused = await createOk(H4b, { visibility: 'members' })
    await setDefaults(H4b, { visibility: 'friends' })
    let successor = 0
    mutationHooks.at = async (point, code, label) => {
      if (point !== 'beforeLock' || label !== 'moment-defaults-apply' || code !== reused || successor) return
      await prisma.$executeRaw`UPDATE sessions SET deleted_at = now(), code = NULL WHERE code = ${reused}`
      successor = Number((await prisma.$queryRaw`INSERT INTO sessions (code, host_user_id, visibility, created_at) VALUES (${reused}, ${H4b.id}, 'members', now()) RETURNING id` as J[])[0].id)
    }
    const r4b = await apply(H4b, { field: 'visibility' })
    noHooks()
    check('🔒 the code reused by a new moment of the same host between the scan and the lock: the successor is not written (bound by id)',
      r4b.status === 200 && successor > 0 && (await colsById(successor)).visibility === 'members', [r4b.json, successor])
    // Reverse race: scanned widening, a narrowing by the time of the lock, budget spent.
    const H5 = await mkUser('MD Host 5')
    const rev = await createOk(H5, { visibility: 'members' })
    await setDefaults(H5, { visibility: 'followers' })
    await resetLimits()
    await redis.set(applySectionKey(H5.id, 'host').key, '10', { EX: 3600 })
    mutationHooks.at = async (point, code, label) => {
      if (point === 'beforeLock' && label === 'moment-defaults-apply' && code === rev) await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE code = ${rev}`
    }
    const r5 = await apply(H5, { field: 'visibility' }, { keep: true })
    noHooks()
    check('🔒 the reverse race: scanned widening, narrowed before the lock, spent budget → written as a narrowing, nothing charged',
      r5.status === 200 && (await cols(rev)).visibility === 'followers' && (await count(applySectionKey(H5.id, 'host').key)) === 10 && (await count(applyItemKey(H5.id, 'host').key)) === 0, [r5.status, r5.json, await cols(rev)])
    // A cohost turns a scanned narrowing into a widening before the lock, spent budget.
    const H6 = await mkUser('MD Host 6')
    const turn = await createOk(H6, { visibility: 'verre' })
    await setDefaults(H6, { visibility: 'friends' })
    await resetLimits()
    await redis.set(applySectionKey(H6.id, 'host').key, '10', { EX: 3600 })
    mutationHooks.at = async (point, code, label) => {
      if (point === 'beforeLock' && label === 'moment-defaults-apply' && code === turn) await prisma.$executeRaw`UPDATE sessions SET visibility = 'members' WHERE code = ${turn}`
    }
    const r6 = await apply(H6, { field: 'visibility' }, { keep: true })
    noHooks()
    check('🔒 a cohost turned a scanned narrowing into a widening before the lock, spent budget → not written, 429 (direction from the LOCKED row)',
      r6.status === 429 && (await cols(turn)).visibility === 'members' && (await count(applyItemKey(H6.id, 'host').key)) === 0, [r6.status, r6.json, await cols(turn)])
    // Every narrowing before the reservation; a Redis stall at the reservation.
    const H7 = await mkUser('MD Host 7')
    const n7 = await createOk(H7, { visibility: 'verre' })
    const w7 = await createOk(H7, { visibility: 'members' })
    await setDefaults(H7, { visibility: 'friends' })
    const order: string[] = []
    mutationHooks.at = async (point, code, label) => { if (point === 'beforeCommit' && label === 'moment-defaults-apply') order.push(`commit:${code}`) }
    momentDefaultsSeams.redis = async (step) => {
      if (step === 'reserve') { order.push('reserve'); await new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 3000)) }
    }
    await resetLimits()
    await redis.set(applyItemKey(H7.id, 'host').key, '5', { EX: 3600 })
    const t7 = Date.now()
    const r7 = await apply(H7, { field: 'visibility' }, { keep: true })
    const e7 = Date.now() - t7
    noHooks()
    await sleep(3_200)
    check('🔒 …a timed-out charge whose increment never ran is never refunded (an earlier charge stays: Codex build r2)', (await count(applyItemKey(H7.id, 'host').key)) === 5, await count(applyItemKey(H7.id, 'host').key))
    check('🔒 every narrowing commits BEFORE the reservation is asked for (two passes)', order[0] === `commit:${n7}` && order.indexOf('reserve') > 0, order)
    check('🔒 a Redis stall at the reservation: refused within the deadline (fails CLOSED: 429), the narrowing applied, the widening left',
      r7.status === 429 && e7 < REDIS_DEADLINE_MS + 1500 && (await cols(n7)).visibility === 'friends' && (await cols(w7)).visibility === 'members', [r7.status, e7])
    // A Redis ERROR at the reservation (not a stall): refused, and only the key
    // Redis answered is refunded (Codex build r1).
    const H7b = await mkUser('MD Host 7b')
    const e7b = await createOk(H7b, { visibility: 'members' })
    await setDefaults(H7b, { visibility: 'friends' })
    await resetLimits()
    await redis.set(applySectionKey(H7b.id, 'host').key, '3', { EX: 3600 })
    await redis.set(applyItemKey(H7b.id, 'host').key, '5', { EX: 3600 })
    let calls7b = 0
    momentDefaultsSeams.redis = async (step) => { if (step === 'reserve' && ++calls7b === 1) throw new Error('READONLY You can\'t write against a read only replica.') }
    const t7b = Date.now()
    const r7b = await apply(H7b, { field: 'visibility' }, { keep: true })
    const el7b = Date.now() - t7b
    noHooks()
    check('🔒 a Redis error at the reservation: refused at once (fails CLOSED: 429), the widening left (checkRate alone would have allowed it)',
      r7b.status === 429 && el7b < REDIS_DEADLINE_MS + 1500 && (await cols(e7b)).visibility === 'members', [r7b.status, el7b])
    check('🔒 …the errored key is not refunded (it was never charged), the answered one is: both back where they were',
      (await count(applySectionKey(H7b.id, 'host').key)) === 3 && (await count(applyItemKey(H7b.id, 'host').key)) === 5,
      [await count(applySectionKey(H7b.id, 'host').key), await count(applyItemKey(H7b.id, 'host').key)])
    // The advisory lock held past lockTimeoutMs.
    const H8 = await mkUser('MD Host 8')
    const lk = await createOk(H8, { visibility: 'members' })
    const free8 = [await createOk(H8, { visibility: 'members' }), await createOk(H8, { visibility: 'members' })]
    await setDefaults(H8, { show_place: true })
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let locked!: () => void
    const isLocked = new Promise<void>(r => { locked = r })
    const holder = prisma.$transaction(async (tx: J) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`session:${lk}`}))`
      locked()
      await held
    }, { timeout: 20_000 })
    await isLocked
    const t8 = Date.now()
    const r8 = await apply(H8, { field: 'showPlace' })
    const e8 = Date.now() - t8
    release(); await holder
    check('🔒 the advisory lock held past lockTimeoutMs: that moment left as it is, the rest done',
      r8.status === 200 && r8.json.changed === 2 && (await cols(lk)).place === false && (await Promise.all(free8.map(cols))).every(x => x.place === true), r8.json)
    check('🔒 …bounded by the lock timeout (elapsed ≈ lockTimeoutMs, not the holder\'s 20 s)', e8 >= LOCK_TIMEOUT_MS - 100 && e8 < LOCK_TIMEOUT_MS + 2500, e8)
    // A throw after a committed widening keeps both charges.
    const H9 = await mkUser('MD Host 9')
    const t9a = await createOk(H9, { visibility: 'members' })
    const t9b = await createOk(H9, { visibility: 'members' })
    await setDefaults(H9, { show_details: true })
    let seen9 = 0
    mutationHooks.at = async (point, code, label) => {
      if (point === 'locked' && label === 'moment-defaults-apply' && code === t9b && ++seen9 === 2) throw new Error('injected')
    }
    await resetLimits()
    const r9 = await apply(H9, { field: 'showDetails' }, { keep: true })
    noHooks()
    check('🔒 a throw after a committed widening: that moment left, the other written, BOTH charges kept',
      r9.status === 200 && r9.json.changed === 1 && (await cols(t9a)).details === true && (await cols(t9b)).details === false
      && (await count(applySectionKey(H9.id, 'host').key)) === 1 && (await count(applyItemKey(H9.id, 'host').key)) === 1, [r9.json, seen9])

    section('§ 27 c the budgets: narrowing free, a widening = one slot on each key, refunds')
    const HB1 = await mkUser('MD Budget')
    const bN = await createOk(HB1, { visibility: 'verre' })
    const bW = await createOk(HB1, { visibility: 'members' })
    await setDefaults(HB1, { visibility: 'friends' })
    await resetLimits()
    await redis.set(applySectionKey(HB1.id, 'host').key, '10', { EX: 20 })
    const rb1 = await apply(HB1, { field: 'visibility' }, { keep: true })
    check('the 429\'s wait is the refused counter\'s own (an allowed key adds nothing: Codex build r2 P3)', rb1.json.retryAfter > 0 && rb1.json.retryAfter <= 20, rb1.json.retryAfter)
    check('🔒 refused widening (bulk key spent) → 429 AFTER the narrowing part applied', rb1.status === 429 && rb1.json.changed === 1 && (await cols(bN)).visibility === 'friends' && (await cols(bW)).visibility === 'members', rb1.json)
    check('🔒 a refusal on the bulk key leaves the single-item counter unchanged (refund both)', (await count(applyItemKey(HB1.id, 'host').key)) === 0 && (await count(applySectionKey(HB1.id, 'host').key)) === 10,
      [await count(applySectionKey(HB1.id, 'host').key), await count(applyItemKey(HB1.id, 'host').key)])
    await resetLimits()
    await redis.set(applyItemKey(HB1.id, 'host').key, '30', { EX: 3600 })
    const rb2 = await apply(HB1, { field: 'visibility' }, { keep: true })
    check('🔒 …and the reverse: rl:moment-visibility spent → 429, the bulk key unchanged', rb2.status === 429 && (await count(applySectionKey(HB1.id, 'host').key)) === 0 && (await cols(bW)).visibility === 'members',
      [rb2.status, await count(applySectionKey(HB1.id, 'host').key)])

    section('§ 27 c your choices in moments: the scope S, one statement per action')
    const Y = await mkUser('MD You')
    const HY = await mkUser('MD You host')
    const m1 = await createSession(HY); const m1w = await addWine(m1, HY, `${TAG} y1`)
    const m2 = await createSession(HY)
    const m3 = await createSession(HY)
    const m4 = await createSession(HY); const m4w = await addWine(m4, HY, `${TAG} y4`)
    const m5 = await createSession(HY); const m5w = await addWine(m5, HY, `${TAG} y5`)
    const m6 = await createSession(HY)
    await join(m1, Y)                                    // a plain membership
    await remove(m2, HY, Y, 'kick')                      // a kicked placeholder (never joined)
    await join(m3, Y); await mePrivacy(m3, Y, { hiddenFromFeed: true }); await remove(m3, HY, Y, 'kick') // kicked WITH a privacy row
    await join(m4, Y); await rate(m4, Y, m4w.id); await prisma.$executeRaw`DELETE FROM session_members WHERE session_code = ${m4} AND user_id = ${Y.id}` // rating author only
    await join(m5, Y); await rate(m5, Y, m5w.id)
    const s1 = await sid(m1), s2 = await sid(m2), s3 = await sid(m3), s4 = await sid(m4), s5 = await sid(m5), s6 = await sid(m6)
    await resetLimits()
    const d5 = await call(codeRoute.DELETE, 'DELETE', `/api/session/${m5}`, HY, undefined, { code: m5 })
    check('fixture: m5 deleted (Y\'s post of it survives)', d5.status === 200)
    void m1w
    const py = await patchDefault(Y, { onlyInside: true })
    check('the preview over S: a membership, a kicked one with a privacy row, a rating author, a deleted moment\'s post (a placeholder and an unrelated moment out)',
      JSON.stringify(py.json.existing) === JSON.stringify({ field: 'onlyInside', value: true, count: 4, wider: 0, narrower: 4 }), py.json.existing)
    const ay = await apply(Y, { field: 'onlyInside' })
    const rows = await Promise.all([s1, s2, s3, s4, s5, s6].map(s => priv(s, Y.id)))
    check('🔒 a hide reaches exactly S (deleted moment and kicked member included; the placeholder and the unrelated moment get no row)',
      ay.status === 200 && ay.json.changed === 4 && rows[0]?.only_inside === true && rows[1] === null && rows[2]?.only_inside === true && rows[2]?.hidden_from_feed === true
      && rows[3]?.only_inside === true && rows[4]?.only_inside === true && rows[5] === null, [ay.json, rows])
    const ay2 = await apply(Y, { field: 'onlyInside' })
    check('a repeated hide changes nothing', ay2.status === 200 && ay2.json.changed === 0)
    // The legacy strict host's moment is in S (no member row at apply time:
    // their /visit above wrote one back, so drop it again).
    await prisma.$executeRaw`DELETE FROM session_members WHERE session_code = ${LM} AND user_id = ${LH.id}`
    await setDefaults(LH, { only_inside: true })
    const al = await apply(LH, { field: 'onlyInside' })
    check('🔒 a legacy strict host\'s moment (no member row needed) is in S', al.json.changed >= 1 && (await priv(lmSid, LH.id))?.only_inside === true, al.json)
    // Budgets: a hide is free on spent budgets; two identical shows cost one each.
    await resetLimits()
    await redis.set(applySectionKey(Y.id, 'moments').key, '10', { EX: 3600 })
    await redis.set(applyItemKey(Y.id, 'moments').key, '30', { EX: 3600 })
    await redis.set(applyRequestKey(Y.id).key, '60', { EX: 60 })
    await setDefaults(Y, { only_inside: true, moment_hidden_from_feed: true })
    const fh = await apply(Y, { field: 'momentHiddenFromFeed' }, { keep: true })
    check('🔒 narrowing is never charged or refused: a hide applies on spent bulk, single-item and request budgets', fh.status === 200 && fh.json.changed >= 3 && (await priv(s1, Y.id))?.hidden_from_feed === true, fh.json)
    const so = await patchDefault(Y, { onlyInside: false }, { keep: true })
    const so2 = await apply(Y, { field: 'onlyInside' }, { keep: true })
    check('🔒 the request limiter spent: a show-only apply is 429 before the scan, nothing changed', so.status === 200 && so2.status === 429 && (await priv(s1, Y.id))?.only_inside === true, [so.status, so2.status])
    await resetLimits()
    const [sa, sb] = await Promise.all([apply(Y, { field: 'onlyInside' }, { keep: true }), apply(Y, { field: 'onlyInside' }, { keep: true })])
    check('🔒 two identical show applies at once: one changes, the other is refunded (one slot on each key in all)',
      sa.status === 200 && sb.status === 200 && sa.json.changed + sb.json.changed === 4 && (await count(applySectionKey(Y.id, 'moments').key)) === 1 && (await count(applyItemKey(Y.id, 'moments').key)) === 1,
      [sa.json, sb.json, await count(applySectionKey(Y.id, 'moments').key), await count(applyItemKey(Y.id, 'moments').key)])
    check('…and the show reached S: every row of Y off again', (await Promise.all([s1, s3, s4, s5].map(s => priv(s, Y.id)))).every(r => r?.only_inside === false))
    // A kicked member with an Incognito row, then a bulk Hide from Feed, then rejoin + first rating.
    const KM = await mkUser('MD Kicked member')
    const mk = await createSession(HY); const mkw = await addWine(mk, HY, `${TAG} km`)
    await join(mk, KM); await mePrivacy(mk, KM, { onlyInside: true }); await remove(mk, HY, KM, 'kick')
    await setDefaults(KM, { moment_hidden_from_feed: true })
    await apply(KM, { field: 'momentHiddenFromFeed' })
    await join(mk, KM); await rate(mk, KM, mkw.id)
    const kmSid = await sid(mk)
    const kmPost = await prisma.feedItem.findFirst({ where: { userId: KM.id, sessionId: kmSid }, select: { id: true } })
    check('🔒 kicked with an Incognito row, a bulk Hide from Feed, rejoin + first rating → the post is hidden (Codex r3 P2)', !!kmPost && (await priv(kmSid, KM.id))?.hidden_from_feed === true, await priv(kmSid, KM.id))
    // A Redis stall at the initial peek: the hide still applies within the deadline.
    const PK = await mkUser('MD Peek stall')
    const mp1 = await createSession(HY); await join(mp1, PK)
    await setDefaults(PK, { only_inside: true })
    momentDefaultsSeams.redis = async (step) => { if (step === 'peek' || step === 'charge') await new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 3000)) }
    const tp = Date.now()
    const rp = await apply(PK, { field: 'onlyInside' })
    const ep = Date.now() - tp
    noHooks()
    check('🔒 a Redis stall at the initial peek: the hide applies within the deadline (the limiter fails OPEN)', rp.status === 200 && rp.json.changed === 1 && ep < REDIS_DEADLINE_MS + 1500, [rp.status, ep])
    // Account deletion's lock order: the apply holds its parents, the deletion waits.
    const AD = await mkUser('MD Deletes')
    const ma = await createSession(HY); await join(ma, AD)
    const mb = await createSession(HY); await join(mb, AD)
    await setDefaults(AD, { only_inside: true })
    let deletion: Promise<unknown> | null = null
    momentDefaultsSeams.afterParentLocks = async (uid) => {
      if (uid !== AD.id) return
      deletion = deleteAccountDurable(AD.id).then(() => 'deleted', (e: Error) => `threw: ${e?.message}`)
      await sleep(500)
    }
    const ra = await apply(AD, { field: 'onlyInside' })
    noHooks()
    const dres = await Promise.race([deletion, sleep(15_000).then(() => 'timed out')])
    const gone = await prisma.user.findUnique({ where: { id: AD.id }, select: { id: true } })
    check('🔒 the apply interleaved with the same user\'s account deletion: no deadlock, both finish', ra.status === 200 && dres === 'deleted' && gone === null, [ra.status, ra.json, dres])

    // The same for the check-ins statement (your users row first: Codex build r1).
    const AD2 = await mkUser('MD Deletes 2')
    await checkinPost(AD2); await checkinPost(AD2)
    await setDefaults(AD2, { checkin_hidden_from_feed: true })
    let deletion2: Promise<unknown> | null = null
    momentDefaultsSeams.afterParentLocks = async (uid) => {
      if (uid !== AD2.id) return
      deletion2 = deleteAccountDurable(AD2.id).then(() => 'deleted', (e: Error) => `threw: ${e?.message}`)
      await sleep(500)
    }
    const ra2 = await apply(AD2, { field: 'checkinHiddenFromFeed' })
    noHooks()
    const dres2 = await Promise.race([deletion2, sleep(15_000).then(() => 'timed out')])
    check('🔒 the check-ins apply interleaved with account deletion: your row locked first, both finish', ra2.status === 200 && dres2 === 'deleted', [ra2.status, ra2.json, dres2])

    section('§ 27 c check-ins: one statement, your standalone posts only')
    const Q = await mkUser('MD Q')
    const q1 = await checkinPost(Q), q2 = await checkinPost(Q, { hiddenFromFeed: true })
    const other = await checkinPost(C, { hiddenFromFeed: false })
    const pq = await patchDefault(Q, { checkinHiddenFromFeed: true })
    check('the check-in preview counts your check-ins that differ', JSON.stringify(pq.json.existing) === JSON.stringify({ field: 'checkinHiddenFromFeed', value: true, count: 1, wider: 0, narrower: 1 }), pq.json.existing)
    const aq = await apply(Q, { field: 'checkinHiddenFromFeed' })
    check('🔒 a hide reaches your check-ins only (another person\'s untouched)', aq.json.changed === 1 && (await fiHidden(q1.json.id)) && (await fiHidden(q2.json.id)) && (await fiHidden(other.json.id)) === false, aq.json)
    await patchDefault(Q, { checkinHiddenFromFeed: false })
    await resetLimits()
    const aq2 = await apply(Q, { field: 'checkinHiddenFromFeed' }, { keep: true })
    check('a show = one slot on the check-ins bulk key + one on rl:post-privacy', aq2.json.changed === 2 && (await count(applySectionKey(Q.id, 'checkins').key)) === 1 && (await count(applyItemKey(Q.id, 'checkins').key)) === 1, aq2.json)

    section('§ 27 c the flags: a WIDENING apply respects the write fence; copying and narrowing never check one')
    flags(false, true)
    const HF = await mkUser('MD Flag host')
    const fN = await createOk(HF, { visibility: 'verre' })
    const fW = await createOk(HF, { visibility: 'members', showPlace: false })
    await setDefaults(HF, { visibility: 'friends', show_place: true, only_inside: false })
    const fa = await apply(HF, { field: 'showPlace' })
    const fb = await apply(HF, { field: 'visibility' })
    const fc = await apply(HF, { field: 'onlyInside' })
    check('🔒 MOMENT_LOOKIN_ENABLED off: a show-only host apply and an Incognito show are 404, nothing written', fa.status === 404 && fc.status === 404 && (await cols(fW)).place === false, [fa.status, fc.status])
    check('🔒 …a mixed Visible To apply still applies its narrowing (no 429), the widening left', fb.status === 200 && (await cols(fN)).visibility === 'friends' && (await cols(fW)).visibility === 'members', [fb.status, fb.json])
    // A middle Visible To can be widening only too (review r1 P3).
    const fg = await apply(HF, { field: 'visibility' })
    check('🔒 …the same default again, now widening only (every moment on Only People Who Joined): 404, nothing written', fg.status === 404 && (await cols(fN)).visibility === 'friends' && (await cols(fW)).visibility === 'members', [fg.status, fg.json])
    flags(true, false)
    await setDefaults(Q, { checkin_hidden_from_feed: false, moment_hidden_from_feed: false })
    const fd = await apply(Q, { field: 'checkinHiddenFromFeed' })
    const fe = await apply(Q, { field: 'momentHiddenFromFeed' })
    await setDefaults(Q, { checkin_hidden_from_feed: true })
    const ff = await apply(Q, { field: 'checkinHiddenFromFeed' })
    check('🔒 HIDE_FROM_FEED_ENABLED off: both Hide from Feed shows are 404; a hide still applies', fd.status === 404 && fe.status === 404 && ff.status === 200 && (await fiHidden(q1.json.id)) === true, [fd.status, fe.status, ff.status])
    flags(true, true)

    // ── § 27 d ─────────────────────────────────────────────────────────────
    section('§ 27 d account deletion cascades; SYSTEM_DEFAULTS = the column defaults')
    const DD = await mkUser('MD Cascade')
    await setDefaults(DD, { only_inside: true })
    await deleteAccountDurable(DD.id)
    const left = await prisma.$queryRaw`SELECT 1 FROM moment_defaults WHERE user_id = ${DD.id}` as J[]
    check('the defaults row goes with the account (ON DELETE CASCADE)', left.length === 0)
    const defs = await prisma.$queryRaw`
      SELECT table_name || '.' || column_name AS c, column_default AS d FROM information_schema.columns
       WHERE (table_name = 'sessions' AND column_name IN ('visibility', 'include_guest_circles', 'show_place', 'show_details'))
          OR (table_name = 'moment_privacy' AND column_name IN ('only_inside', 'hidden_from_feed'))
          OR (table_name = 'feed_items' AND column_name = 'hidden_from_feed')` as J[]
    const d = Object.fromEntries(defs.map(r => [r.c, String(r.d)]))
    const want = {
      'sessions.visibility': `'${SYSTEM_DEFAULTS.visibility}'::character varying`, 'sessions.include_guest_circles': String(SYSTEM_DEFAULTS.includeGuestCircles),
      'sessions.show_place': String(SYSTEM_DEFAULTS.showPlace), 'sessions.show_details': String(SYSTEM_DEFAULTS.showDetails),
      'moment_privacy.only_inside': String(SYSTEM_DEFAULTS.onlyInside), 'moment_privacy.hidden_from_feed': String(SYSTEM_DEFAULTS.momentHiddenFromFeed),
      'feed_items.hidden_from_feed': String(SYSTEM_DEFAULTS.checkinHiddenFromFeed),
    }
    check('🔒 SYSTEM_DEFAULTS equals the column defaults of sessions / moment_privacy / feed_items', JSON.stringify(Object.keys(want).map(k => d[k])) === JSON.stringify(Object.values(want)), { d, want })

    // ── § 27 e ─────────────────────────────────────────────────────────────
    section('§ 27 e the membership-write census')
    const run = (args: string[]) => { try { return { ok: true, out: execFileSync('node', ['scripts/check-member-writes.mjs', ...args], { encoding: 'utf8' }) } } catch (e) { return { ok: false, out: String((e as { stdout?: string }).stdout ?? e) } } }
    const st = run(['--self-test'])
    const full = run([])
    check('the census\'s self-test (its negative controls: a missed write, an ENTRY with no seed, a seed only in the next function)', st.ok && /self-test OK/.test(st.out), st.out)
    check('the census over app/ + lib/: every session_members write classified, ENTRY ones seed, NOT ENTRY ones don\'t', full.ok && /OK/.test(full.out), full.out)
  } finally {
    noHooks()
    if (saved.mv === undefined) delete process.env.MOMENT_LOOKIN_ENABLED; else process.env.MOMENT_LOOKIN_ENABLED = saved.mv
    if (saved.hff === undefined) delete process.env.HIDE_FROM_FEED_ENABLED; else process.env.HIDE_FROM_FEED_ENABLED = saved.hff
  }
}
