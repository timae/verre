// § 26 Moment Visibility, step 3b: "Private Moment" (R16–R19,
// .local/moment-visibility/step3b-plan.md § 6). Imported by
// scripts/tests/you-profile-integration.mts after § 25, with the same harness:
// every response through `call` passes the integer canary.
//   § 26 a the leak matrix: viewers × surfaces (feed network, ?user=, ?item=,
//          web profile signed in and out, someone's Impressions and its q by
//          the moment's name), each answer compared with the decision's own;
//          T5 (no host, no sessionId); own Cravings (T6); the flag off (T3)
//   § 26 b a nameless legacy moment (T4: liveness, not the name)
//   § 26 c a throwing decision (T8): own posts / insiders named, pages served
//   § 26 d decideAdmission == decideMoments' { member, open } over the
//          audience table; no people statement when nothing bridges
//   § 26 e the heavy case: a Followers-tier bridge through Friends of Friends
//   § 26 f someone's Impressions: one candidate set whatever q, the two paths
//          label alike, q across cursor pages, the top-up (disjoint) on a score
//          sort, a 101st moment's row not found by its name, a stripped blind
//          row (T7), the flag off runs no decision
//   § 26 g the Incognito race between the candidates and the list statement
//   § 26 h a deleted moment's post never carries privateMoment
import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { MomentVisibilityHarness } from './moment-visibility-section.mts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Bare = { id: number; pid: string }
type Res = { status: number; json: J; wire: J; headers: Headers }
type Tier = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual'
type Raw = (...a: unknown[]) => unknown

const word = (n = 12) => [...randomBytes(n)].map(b => String.fromCharCode(97 + (b % 26))).join('')

export async function privateMoment(h: MomentVisibilityHarness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, TAG } = h
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const bookmarkRoute = await import('../../app/api/session/[code]/wines/[wineId]/bookmark/route.ts')
  const craveRoute = await import('../../app/api/feed-items/[id]/crave/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const usersRoute = await import('../../app/api/users/[id]/route.ts')
  const impressionsRoute = await import('../../app/api/users/[id]/impressions/route.ts')
  const cravingsRoute = await import('../../app/api/users/[id]/cravings/route.ts')
  const { decideMoments, decideAdmission } = await import('../../lib/momentAudience.ts')
  const { loadImpressions } = await import('../../lib/profileLists.ts')
  const { resolveProfileViewer } = await import('../../lib/profileVisibility.ts')

  const saved = process.env.MOMENT_LOOKIN_ENABLED
  const flag = (on: boolean) => { if (on) process.env.MOMENT_LOOKIN_ENABLED = 'true'; else delete process.env.MOMENT_LOOKIN_ENABLED }

  // ── helpers ────────────────────────────────────────────────────────────────
  let seq = 0
  const settings = (tier: Tier, o: { fof?: boolean; show?: boolean } = {}) => ({ profileVisibility: tier, visibilityFof: o.fof ?? false, checkinVisibility: null, showMoments: o.show ?? true })
  const setSettings = (id: number, tier: Tier, o: { fof?: boolean; show?: boolean } = {}) => prisma.user.update({ where: { id }, data: settings(tier, o) })
  const bareMany = async (n: number, prefix: string, data: J = {}): Promise<Bare[]> => {
    const emails = Array.from({ length: n }, () => `${TAG}-pm-${++seq}@example.test`)
    await prisma.user.createMany({ data: emails.map((email, i) => ({ name: `${prefix} ${i}`, email, ...data })) })
    const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, publicId: true, email: true } }) as J[]
    const by = new Map(rows.map(r => [r.email as string, r]))
    return emails.map(e => ({ id: by.get(e)!.id as number, pid: by.get(e)!.publicId as string }))
  }
  const bare = async (name: string, data: J = settings('public-users')) => (await bareMany(1, name, data))[0]
  const mutual = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }, { followerId: b, followingId: a }], skipDuplicates: true })
  const follows = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }], skipDuplicates: true })
  const blocks = (a: number, b: number) => prisma.userBlock.create({ data: { blockerId: a, blockedId: b } })
  const rawCode = () => `PM${randomBytes(8).toString('hex').toUpperCase().slice(0, 10)}`
  const rawMoment = async (hostId: number | null, o: { visibility?: string; igc?: boolean; name?: string | null; dateFrom?: string; blind?: boolean; members?: { id: number; kicked?: boolean }[] } = {}) => {
    const code = rawCode()
    const [r] = await prisma.$queryRaw`
      INSERT INTO sessions (code, host_user_id, host_name, name, created_at, date_from, visibility, include_guest_circles, blind)
      VALUES (${code}, ${hostId}, 'Raw Host', ${o.name === undefined ? `${TAG} pm raw` : o.name}, now(), ${o.dateFrom ?? new Date(Date.now() + 3600_000).toISOString()}::timestamptz,
              ${o.visibility ?? 'friends'}, ${o.igc ?? true}, ${o.blind ?? false})
      RETURNING id, public_id` as J[]
    const members = [...(hostId !== null ? [{ id: hostId, role: 'host' }] : []), ...(o.members ?? []).map(m => ({ ...m, role: 'taster' }))]
    if (members.length) await prisma.sessionMember.createMany({ data: members.map(m => ({ userId: m.id, sessionCode: code, role: m.role, removedState: 'kicked' in m && m.kicked ? 'kicked' : null })) })
    return { id: r.id as number, pid: r.public_id as string, code }
  }
  // A rating of `userId` on a new bottle of the moment (no post: Impressions only).
  const rawRating = async (sessionId: number, userId: number, bottle: string, score: number, at = new Date().toISOString()) => {
    const wid = randomBytes(10).toString('base64url').slice(0, 21)
    await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, position, created_at, colour) VALUES (${wid}, ${sessionId}, ${bottle}, 0, now(), 'red')`
    const [r] = await prisma.$queryRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${wid}, ${userId}, ${sessionId}, 'session', 'r', ${score}, ${at}::timestamptz) RETURNING id` as J[]
    return r.id as number
  }
  const join = async (code: string, a: Actor, name = 'Joiner') => {
    await resetLimits()
    const r = await call(joinRoute.POST, 'POST', '/api/session/join', a, { code, displayName: name })
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const rate = async (code: string, a: Actor, wineId: string) => {
    await resetLimits()
    const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, a, { wineId, score: 4, flavors: { body: 3 }, notes: 'pm note' }, { code })
    if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const remove = async (code: string, host: Actor, target: User, mode: 'kick' | 'ban') => {
    await resetLimits()
    const r = await call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, host, { identityId: `u:${target.pid}`, mode }, { code })
    if (r.status !== 200) throw new Error(`${mode} failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const feed = async (v: Actor, q = '') => { await resetLimits(); return call(feedRoute.GET, 'GET', `/api/feed${q}`, v) }
  const ofUser = async (v: Actor, u: { pid: string }, item?: number) => feed(v, `?user=${u.pid}${item ? `&item=${item}` : ''}`)
  const sessionPost = (r: Res, id: number) => ((r.wire?.items ?? []) as J[]).find(i => i.type === 'session' && i.session?.id === id)?.session as J | undefined
  const web = async (owner: { pid: string }, v: Actor) => { await resetLimits(); return call(usersRoute.GET, 'GET', `/api/users/${owner.pid}`, v, undefined, { id: owner.pid }) }
  const webPost = (r: Res, id: number) => ((r.wire?.recentSessionPosts ?? []) as J[]).find(p => p.id === id)
  const impressions = async (owner: { pid: string }, v: Actor, q = '') => { await resetLimits(); return call(impressionsRoute.GET, 'GET', `/api/users/${owner.pid}/impressions${q}`, v, undefined, { id: owner.pid }) }
  const rowsOf = (r: Res) => (r.wire?.items ?? []) as J[]
  const rowById = (r: Res, id: number) => rowsOf(r).find(x => x.id === id)
  const cravings = async (owner: { pid: string }, v: Actor) => { await resetLimits(); return call(cravingsRoute.GET, 'GET', `/api/users/${owner.pid}/cravings`, v, undefined, { id: owner.pid }) }
  const sessionOf = async (code: string) => (await prisma.$queryRaw`SELECT id, public_id FROM sessions WHERE code = ${code}` as J[])[0] as { id: number; public_id: string }
  const postOf = async (userId: number, sessionId: number) => (await prisma.feedItem.findFirstOrThrow({ where: { userId, sessionId }, select: { id: true } })).id as number
  const ratingOf = async (userId: number, sessionId: number) => (await prisma.rating.findFirstOrThrow({ where: { userId, sessionId }, select: { id: true } })).id as number

  // The post as a viewer who may see the name (or not) must get it.
  const postShape = (p: J | undefined, named: boolean, name: string | null, sid: number) => !!p && (named
    ? p.sessionName === name && p.sessionId === sid && !('privateMoment' in p)
    : p.privateMoment === true && p.sessionName === null && p.hostName === null && p.sessionId === null && !('momentId' in p))
  const rowShape = (r: J | undefined, named: boolean, name: string | null) => !!r && (named
    ? (name === null ? !('momentName' in r) : r.momentName === name) && !('privateMoment' in r)
    : r.privateMoment === true && !('momentName' in r))

  // A spy on the app's raw statements (the client the lib modules share).
  const orig = prisma.$queryRaw as Raw
  // The statement FLATTENED (fragments are values of the outer template), so a
  // check on its text sees the fragments too; `ids` = its first array value.
  const flat = (a: unknown[]): Prisma.Sql => (Array.isArray(a[0]) ? Prisma.sql(a[0] as string[], ...(a.slice(1) as Prisma.Sql[])) : a[0] as Prisma.Sql)
  type Seen = { text: string; ids: number[] | null }
  const spy = async <R>(fn: () => Promise<R>, o: { failOn?: RegExp; failNth?: { on: RegExp; n: number }; before?: { on: RegExp; run: () => Promise<unknown> } } = {}): Promise<{ r: R; seen: Seen[] }> => {
    const seen: Seen[] = []
    let fired = false, nth = 0
    prisma.$queryRaw = (...a: unknown[]) => {
      const f = flat(a)
      const text = f.sql
      const ids = (f.values.find(x => Array.isArray(x)) as number[] | undefined) ?? null
      seen.push({ text, ids })
      if (o.failOn?.test(text)) return Promise.reject(new Error('3b seam: the decision is unavailable'))
      if (o.failNth?.on.test(text) && ++nth === o.failNth.n) return Promise.reject(new Error('3b seam: this decision is unavailable'))
      if (o.before && !fired && o.before.on.test(text)) { fired = true; return o.before.run().then(() => orig.apply(prisma, a)) }
      return orig.apply(prisma, a)
    }
    try { return { r: await fn(), seen } } finally { prisma.$queryRaw = orig }
  }
  const MOMENTS_STMT = /AS host_block/ // decide's first statement (both exports)
  const PEOPLE_STMT = /WITH mo AS \(/
  const CANDIDATES_STMT = /SELECT DISTINCT r\.session_id FROM ratings r/
  const LIST_STMT = /AS had_key/
  const decisions = (seen: Seen[]) => seen.filter(s => MOMENTS_STMT.test(s.text)).map(s => [...(s.ids ?? [])].sort((x, y) => x - y))

  try {
    flag(true)

    // ── § 26 a ───────────────────────────────────────────────────────────────
    section('§ 26 a the leak matrix: the moment\'s name only to a viewer who could open it')
    const NAME = `Wombat Lantern Soiree ${word(6)}`
    const H = await mkUser('Hedda Host'), A = await mkUser('Arno Author'), B = await mkUser('Bea Bridge'), Ak = await mkUser('Kurt Kickedauthor')
    const Vm = await mkUser('Vera Member'), Vk = await mkUser('Kim Kicked'), Vb = await mkUser('Ben Banned'), Vx = await mkUser('Xia Blocked')
    const Vf = await mkUser('Finn Hostfriend'), Vbr = await mkUser('Bo Bridgefriend'), Vfo = await mkUser('Flo Hostfollower'), Vs = await mkUser('Sam Stranger')
    const viewers = [Vm, Vk, Vb, Vx, Vf, Vbr, Vfo, Vs]
    for (const u of [H, A, Ak]) await setSettings(u.id, 'public-internet')
    for (const u of [B, ...viewers]) await setSettings(u.id, 'public-users')
    await mutual(Vf.id, H.id); await mutual(Vbr.id, B.id); await mutual(Vb.id, H.id); await mutual(Vx.id, H.id); await follows(Vfo.id, H.id)
    await blocks(H.id, Vx.id)
    for (const v of viewers) { await follows(v.id, A.id); await follows(v.id, Ak.id) }
    const code = await createSession(H, 'Hedda Host')
    for (const u of [A, B, Ak, Vm, Vk, Vb]) await join(code, u)
    const w = await addWine(code, H, `${TAG} PM Bottle`)
    await rate(code, A, w.id); await rate(code, Ak, w.id)
    const { id: sid } = await sessionOf(code)
    await prisma.$executeRaw`UPDATE sessions SET name = ${NAME}, visibility = 'friends', include_guest_circles = true WHERE id = ${sid}`
    await remove(code, H, Vk, 'kick'); await remove(code, H, Vb, 'ban'); await remove(code, H, Ak, 'kick')
    const postA = await postOf(A.id, sid), postAk = await postOf(Ak.id, sid)
    const ratingA = await ratingOf(A.id, sid), ratingAk = await ratingOf(Ak.id, sid)
    check('fixture: the kicked author keeps their post and rating', !!postAk && !!ratingAk)

    const surfaces = async (label: string, owner: User, post: number, rating: number, v: User | null, vis: string, igc: boolean, want: boolean, o: { hostNamed?: boolean; host?: boolean } = {}) => {
      await prisma.$executeRaw`UPDATE sessions SET visibility = ${vis}, include_guest_circles = ${igc} WHERE id = ${sid}`
      const tag = `${label} (${vis}${igc ? ' + circles' : ''})`
      if (v === null) {
        const wp = webPost(await web(owner, {}), post)
        check(`${tag}: web profile signed out → ${want ? 'named' : 'Private Moment'}`, postShape(wp, want, NAME, sid), wp)
        return
      }
      const d = (await decideMoments(v.id, [sid])).get(sid)
      const named = v.id === owner.id || (!!d && (d.member || d.open))
      check(`${tag}: the decision (own || member || open) says ${want ? 'named' : 'private'}`, named === want, d && { member: d.member, open: d.open, hostNamed: d.hostNamed })
      if (o.hostNamed) check(`${tag}: T5, the host IS named to them (so a null host line below is the rule, not the host's privacy)`, d?.hostNamed === true)
      const posts = [sessionPost(await feed(v), post), sessionPost(await ofUser(v, owner), post), sessionPost(await ofUser(v, owner, post), post), webPost(await web(owner, v), post)]
      check(`${tag}: feed network, ?user=, ?item=, web profile ${want ? 'carry the name' : 'read privateMoment: no name, no host, no sessionId, no momentId (T5)'}`,
        posts.every(p => postShape(p, want, NAME, sid)), posts.map(p => p && { sessionName: p.sessionName, hostName: p.hostName, sessionId: p.sessionId, privateMoment: p.privateMoment, momentId: p.momentId }))
      // The host line where it belongs (review: the admitted outsider's only positive check).
      if (o.host) check(`${tag}: the host's name on all four (in the moment, or could open it and the host shows to them)`, posts.every(p => p?.hostName === 'Hedda Host'), posts.map(p => p?.hostName))
      const row = rowById(await impressions(owner, v), rating)
      check(`${tag}: their Impressions row ${want ? 'carries momentName' : 'reads privateMoment'}`, rowShape(row, want, NAME), row)
      const found = rowById(await impressions(owner, v, `?q=${encodeURIComponent(NAME)}`), rating)
      check(`${tag}: q by the moment's name finds it exactly when named, never as a Private Moment row`, want ? rowShape(found, true, NAME) : !found, found)
    }
    await surfaces('the author', A, postA, ratingA, A, 'friends', true, true)
    await surfaces('a kicked author\'s own post', Ak, postAk, ratingAk, Ak, 'friends', true, true)
    await surfaces('a member', A, postA, ratingA, Vm, 'friends', true, true, { host: true })
    await surfaces('a kicked viewer (no edge)', A, postA, ratingA, Vk, 'friends', true, false)
    await surfaces('a banned viewer (the host\'s friend)', A, postA, ratingA, Vb, 'friends', true, false)
    await surfaces('a banned viewer on an Everyone moment', A, postA, ratingA, Vb, 'verre', false, false)
    await surfaces('a block pair with the host', A, postA, ratingA, Vx, 'friends', true, false)
    await surfaces('open by the host\'s edge', A, postA, ratingA, Vf, 'friends', true, true, { host: true })
    await surfaces('open by a named member\'s edge (a bridge)', A, postA, ratingA, Vbr, 'friends', true, true, { host: true })
    await surfaces('the same bridge without guests\' circles', A, postA, ratingA, Vbr, 'friends', false, false)
    await surfaces('a follower the audience doesn\'t admit', A, postA, ratingA, Vfo, 'friends', true, false, { hostNamed: true })
    await surfaces('the same follower, Your Followers', A, postA, ratingA, Vfo, 'followers', false, true)
    await surfaces('Only People in It, the host\'s friend', A, postA, ratingA, Vf, 'members', true, false, { hostNamed: true })
    await surfaces('a stranger, Your Friends', A, postA, ratingA, Vs, 'friends', true, false, { hostNamed: true })
    await surfaces('a stranger, Verre Users, signed in', A, postA, ratingA, Vs, 'verre', false, true, { host: true })
    await surfaces('Verre Users, signed out', A, postA, ratingA, null, 'verre', false, false)
    await surfaces('Your Friends, signed out', A, postA, ratingA, null, 'friends', true, false)
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends', include_guest_circles = true WHERE id = ${sid}`

    // Own Cravings (T6): a bottle saved from a private post names no moment;
    // one saved inside the moment does.
    {
      await resetLimits()
      const c1 = await call(craveRoute.POST, 'POST', `/api/feed-items/${postA}/crave`, Vs, { ratingId: ratingA }, { id: String(postA) })
      await resetLimits()
      const c2 = await call(bookmarkRoute.POST, 'POST', `/api/session/${code}/wines/${w.id}/bookmark`, Vm, undefined, { code, wineId: w.id })
      check('fixture: the stranger saves the bottle from A\'s (private to them) post; the member saves it inside the moment', c1.status === 200 && c2.status === 200, [c1.status, c2.status])
      const sRow = rowsOf(await cravings(Vs, Vs)).find(r => String(r.name).includes('PM Bottle'))
      const mRow = rowsOf(await cravings(Vm, Vm)).find(r => String(r.name).includes('PM Bottle'))
      check('🔒 your own Cravings: a bottle saved from someone\'s post carries no momentName (T6)', !!sRow && !('momentName' in sRow) && !('privateMoment' in sRow), sRow)
      check('…one saved inside a moment you were there in keeps it', mRow?.momentName === NAME, mRow)
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${sid}`
      const sOpen = rowsOf(await cravings(Vs, Vs)).find(r => String(r.name).includes('PM Bottle'))
      check('…and still none once the stranger could open the moment (only "you were there" names it)', !!sOpen && !('momentName' in sOpen), sOpen)
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends' WHERE id = ${sid}`
    }

    // The flag off (T3): open is false, so only own and member are named; the
    // list runs no decision at all.
    {
      flag(false)
      const fF = sessionPost(await ofUser(Vf, A), postA), fM = sessionPost(await ofUser(Vm, A), postA), fA = sessionPost(await ofUser(A, A), postA)
      check('🔒 flag off: the host\'s friend reads Private Moment; the member and the author the name', postShape(fF, false, NAME, sid) && postShape(fM, true, NAME, sid) && postShape(fA, true, NAME, sid), [fF, fM, fA].map(p => p?.sessionName))
      const { r: li, seen } = await spy(() => impressions(A, Vf))
      check('🔒 flag off: the host\'s friend\'s Impressions row is private, and no decision ran (no candidates, no moments statement)',
        rowShape(rowById(li, ratingA), false, NAME) && !seen.some(s => CANDIDATES_STMT.test(s.text) || MOMENTS_STMT.test(s.text)), seen.map(s => s.text.slice(0, 60)))
      check('…the member\'s row is named (the insider column)', rowShape(rowById(await impressions(A, Vm), ratingA), true, NAME))
      const { r: qm, seen: qs } = await spy(async () => ({ m: await impressions(A, Vm, `?q=${encodeURIComponent(NAME)}`), f: await impressions(A, Vf, `?q=${encodeURIComponent(NAME)}`) }))
      check('🔒 flag off, q by the moment\'s name: the member finds the row named, the host\'s friend finds nothing, and no decision ran',
        rowShape(rowById(qm.m, ratingA), true, NAME) && !rowById(qm.f, ratingA) && !qs.some(x => CANDIDATES_STMT.test(x.text) || MOMENTS_STMT.test(x.text)), [rowById(qm.m, ratingA), rowById(qm.f, ratingA)])
      flag(true)
    }

    // A signed-out viewer through the loader itself (no route serves it today,
    // security review P3): no insider, nothing admitted, so private and never
    // found by the name.
    {
      const gateOut = await resolveProfileViewer(A.id, null)
      check('fixture: a signed-out viewer may see A\'s posts', gateOut.status === 'ok')
      const filters = { q: '', from: null, to: null, category: null, min: null, max: null, structure: [], aromas: [], aromaMode: 'all' as const, common: false, sort: 'newest' as const, cursor: null }
      const out = await loadImpressions(A.id, gateOut as never, filters)
      const outQ = await loadImpressions(A.id, gateOut as never, { ...filters, q: NAME })
      check('🔒 signed out: the row reads privateMoment, and q by the moment\'s name finds nothing',
        rowShape(out.items.find(x => x.id === ratingA) as J | undefined, false, NAME) && !outQ.items.some(x => x.id === ratingA), [out.items.find(x => x.id === ratingA), outQ.items.length])
    }

    // ── § 26 b ───────────────────────────────────────────────────────────────
    section('§ 26 b a nameless legacy moment: private by liveness, not by the name (T4)')
    {
      await prisma.$executeRaw`UPDATE sessions SET name = NULL WHERE id = ${sid}`
      const nF = sessionPost(await ofUser(Vf, A), postA), nS = sessionPost(await ofUser(Vs, A), postA)
      check('🔒 a nameless moment: the viewer who could open it gets no name and NO privateMoment; the stranger gets privateMoment',
        postShape(nF, true, null, sid) && postShape(nS, false, null, sid), [nF, nS])
      const rF = rowById(await impressions(A, Vf), ratingA), rS = rowById(await impressions(A, Vs), ratingA)
      check('…and on Impressions the same', rowShape(rF, true, null) && rowShape(rS, false, null), [rF, rS])
      check('…the web profile signed out: privateMoment', postShape(webPost(await web(A, {}), postA), false, null, sid))
      await prisma.$executeRaw`UPDATE sessions SET name = ${NAME} WHERE id = ${sid}`
    }

    // ── § 26 c ───────────────────────────────────────────────────────────────
    section('§ 26 c a throwing decision (T8): own posts on the feed, insiders on the list, pages served')
    {
      const { r } = await spy(async () => ({
        mem: await ofUser(Vm, A), own: await ofUser(A, A), frd: await ofUser(Vf, A), net: await feed(Vf),
        wpOwn: await web(A, A), wpMem: await web(A, Vm),
        liMem: await impressions(A, Vm), liFrd: await impressions(A, Vf), liFrdQ: await impressions(A, Vf, `?q=${encodeURIComponent(NAME)}`),
      }), { failOn: MOMENTS_STMT })
      check('every page served (200)', Object.values(r).every(x => x.status === 200), Object.fromEntries(Object.entries(r).map(([k2, x]) => [k2, x.status])))
      check('🔒 the feed: your own post named, the member\'s and the friend\'s views private during the outage',
        postShape(sessionPost(r.own, postA), true, NAME, sid) && postShape(sessionPost(r.mem, postA), false, NAME, sid) && postShape(sessionPost(r.frd, postA), false, NAME, sid) && postShape(sessionPost(r.net, postA), false, NAME, sid))
      check('🔒 the web profile: the owner named, the member private', postShape(webPost(r.wpOwn, postA), true, NAME, sid) && postShape(webPost(r.wpMem, postA), false, NAME, sid))
      check('🔒 Impressions: the insider named, the admitted friend private, and not found by the name', rowShape(rowById(r.liMem, ratingA), true, NAME) && rowShape(rowById(r.liFrd, ratingA), false, NAME) && !rowById(r.liFrdQ, ratingA))
    }

    // ── § 26 h ───────────────────────────────────────────────────────────────
    section('§ 26 h a deleted moment\'s post never carries privateMoment')
    {
      await resetLimits()
      const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, H, undefined, { code })
      check('fixture: the host deletes the moment', del.status === 200, del.status)
      const dS = sessionPost(await ofUser(Vs, A), postA), dA = sessionPost(await ofUser(A, A), postA)
      check('the stranger and the author: deleted, no name, no privateMoment', [dS, dA].every(p => !!p && p.deleted === true && p.sessionName === null && !('privateMoment' in p)), [dS, dA])
      const wd = webPost(await web(A, {}), postA)
      check('…the web profile signed out too', !!wd && wd.deleted === true && !('privateMoment' in wd), wd)
      const rd = rowById(await impressions(A, Vs), ratingA)
      check('…and their Impressions row: no momentName, no privateMoment', !!rd && !('momentName' in rd) && !('privateMoment' in rd), rd)
    }

    // ── § 26 d ───────────────────────────────────────────────────────────────
    section('§ 26 d decideAdmission == decideMoments\' { member, open } (below the cap)')
    {
      const pub = settings('public-users')
      const [Ha, Ba, Hid, Oi, Mem] = await Promise.all([bare('Hal Audhost'), bare('Bo Bridge'), bare('Hidi Hidden', settings('public-users', { show: false })), bare('Oli Inside'), bare('Meg Member')])
      const vw: Record<string, Bare> = {}
      for (const n of ['hostFriend', 'hostFollower', 'bridgeFriend', 'bridgeFollower', 'hiddenFriend', 'insideFriend', 'stranger', 'kicked', 'banned', 'blockedByHost', 'blocksHost', 'member', 'kickedFriend'])
        vw[n] = await bare(`View ${n}`, pub)
      await mutual(vw.hostFriend.id, Ha.id); await follows(vw.hostFollower.id, Ha.id)
      await mutual(vw.bridgeFriend.id, Ba.id); await follows(vw.bridgeFollower.id, Ba.id)
      await mutual(vw.hiddenFriend.id, Hid.id); await mutual(vw.insideFriend.id, Oi.id)
      for (const n of ['banned', 'blockedByHost', 'blocksHost', 'kickedFriend']) await mutual(vw[n].id, Ha.id)
      await mutual(vw.kicked.id, Ba.id)
      await blocks(Ha.id, vw.blockedByHost.id); await blocks(vw.blocksHost.id, Ha.id)
      const M1 = await rawMoment(Ha.id, { members: [{ id: Ba.id }, { id: Hid.id }, { id: Oi.id }, { id: Mem.id }, { id: vw.member.id }, { id: vw.kicked.id, kicked: true }, { id: vw.kickedFriend.id, kicked: true }] })
      await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${M1.code}, ${`u:${vw.banned.id}`})`
      await prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${M1.id}, ${Oi.id}, true)`
      const HL = await rawMoment(null, { members: [{ id: Ba.id }] })
      const M3 = await rawMoment(Ba.id, { members: [{ id: Ha.id }] })
      const ids = [M1.id, HL.id, M3.id]
      const diffs: J[] = []
      let opened = 0
      for (const on of [true, false]) {
        flag(on)
        for (const vis of ['members', 'friends', 'followers', 'verre']) for (const igc of [false, true]) {
          await prisma.$executeRaw`UPDATE sessions SET visibility = ${vis}, include_guest_circles = ${igc} WHERE id = ANY(${ids}::int[])`
          for (const [n, u] of [...Object.entries(vw), ['signed out', null] as const]) {
            const v = u === null ? null : (u as Bare).id
            const [full, adm] = [await decideMoments(v, ids), await decideAdmission(v, ids)]
            for (const id of ids) {
              const a = full.get(id), b = adm.get(id)
              if (a?.open) opened++
              if (JSON.stringify(a && { member: a.member, open: a.open }) !== JSON.stringify(b)) diffs.push({ on, vis, igc, viewer: n, id, full: a && { member: a.member, open: a.open }, adm: b })
            }
          }
        }
      }
      flag(true)
      check(`🔒 every flag × visibility × guests' circles × viewer (incl. hidden friend, Incognito member, kicked, banned, blocks either way, hostless, signed out) × 3 moments at once: the same { member, open } (${opened} open answers)`,
        diffs.length === 0 && opened > 20, diffs.slice(0, 5))
      check('the answer has no naming (its type is { member, open })', JSON.stringify(Object.keys((await decideAdmission(vw.hostFriend.id, [M1.id])).get(M1.id) ?? {}).sort()) === '["member","open"]')
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends', include_guest_circles = true WHERE id = ANY(${ids}::int[])`
      const direct = await spy(() => decideAdmission(vw.hostFriend.id, [M1.id]))
      const directFull = await spy(() => decideMoments(vw.hostFriend.id, [M1.id]))
      check('🔒 nothing bridges (the host\'s own edge admits): decideAdmission runs NO people statement; decideMoments does (it names the host)',
        direct.r.get(M1.id)?.open === true && !direct.seen.some(s => PEOPLE_STMT.test(s.text)) && directFull.seen.some(s => PEOPLE_STMT.test(s.text)), [direct.seen.length, directFull.seen.length])
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${M1.id}`
      const verre = await spy(() => decideAdmission(vw.stranger.id, [M1.id]))
      check('…an Everyone moment: no people statement either', verre.r.get(M1.id)?.open === true && !verre.seen.some(s => PEOPLE_STMT.test(s.text)))
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends' WHERE id = ${M1.id}`
      const bridged = await spy(() => decideAdmission(vw.bridgeFriend.id, [M1.id]))
      check('…a bridge: exactly one people statement, and no host arm in it (no UNION)', bridged.r.get(M1.id)?.open === true
        && bridged.seen.filter(s => PEOPLE_STMT.test(s.text)).length === 1 && !bridged.seen.find(s => PEOPLE_STMT.test(s.text))!.text.includes('UNION'))
      const stranger = await spy(() => decideAdmission(vw.stranger.id, [M1.id]))
      check('…a stranger on a Friends moment with circles: the moment bridges (one people statement), and stays closed', stranger.r.get(M1.id)?.open === false && stranger.seen.filter(s => PEOPLE_STMT.test(s.text)).length === 1)
    }

    // ── § 26 e ───────────────────────────────────────────────────────────────
    section('§ 26 e the heavy case: a Followers-tier bridge, Friends with Friends of Friends, no follow back')
    {
      const Hh = await bare('Heavy Host'), Bm = await bare('Heavy Bridge', settings('public-mutual', { fof: true }))
      const Fx = await bare('Heavy Friend'), V = await bare('Heavy Viewer')
      await mutual(Bm.id, Fx.id); await mutual(V.id, Fx.id); await follows(V.id, Bm.id)
      const Mh = await rawMoment(Hh.id, { visibility: 'followers', igc: true, members: [{ id: Bm.id }] })
      const a1 = (await decideAdmission(V.id, [Mh.id])).get(Mh.id), f1 = (await decideMoments(V.id, [Mh.id])).get(Mh.id)
      check('🔒 a friend of the bridge\'s friend who follows the bridge: admitted, by both exports', a1?.open === true && f1?.open === true, [a1, f1?.open])
      await prisma.follow.deleteMany({ where: { OR: [{ followerId: V.id, followingId: Fx.id }, { followerId: Fx.id, followingId: V.id }] } })
      const a2 = (await decideAdmission(V.id, [Mh.id])).get(Mh.id), f2 = (await decideMoments(V.id, [Mh.id])).get(Mh.id)
      check('…not a friend of a friend any more: refused by both (the FoF statement decided it)', a2?.open === false && f2?.open === false, [a2, f2?.open])
    }

    // ── § 26 f ───────────────────────────────────────────────────────────────
    section('§ 26 f someone\'s Impressions: one candidate set, two paths, cursor pages, the top-up')
    const O = await bare('Olli Owner', settings('public-internet'))
    const Hr = await bare('Rhea Rawhost')
    const V = await mkUser('Vic Viewer'); await setSettings(V.id, 'public-users')
    const TOKEN = word(10)
    // 105 past moments (most recent first: i = 0 newest), every third closed
    // to the viewer; O rated one bottle in each. The five oldest score 5.
    const fixtures: { i: number; id: number; name: string; open: boolean; rating: number }[] = []
    for (let i = 0; i < 105; i++) {
      const name = word(12), open = i % 3 !== 0, at = new Date(Date.now() - (i + 2) * 86_400_000).toISOString()
      const m = await rawMoment(Hr.id, { visibility: open ? 'verre' : 'members', name, dateFrom: at, members: [{ id: O.id }] })
      // Had at the moment's date, so the newest-first list and the candidates agree.
      fixtures.push({ i, id: m.id, name, open, rating: await rawRating(m.id, O.id, `${TOKEN} bottle ${i}`, i >= 100 ? 5 : 3, at) })
    }
    const byRating = new Map(fixtures.map(f => [f.rating, f]))
    const wantLabel = (row: J) => { const f = byRating.get(row.id); return !!f && rowShape(row, f.open, f.name) }
    const first100 = fixtures.slice(0, 100).map(f => f.id).sort((x, y) => x - y)

    const plain = await spy(() => impressions(O, V))
    const qAll = await spy(() => impressions(O, V, `?q=${TOKEN}`))
    const qNone = await spy(() => impressions(O, V, `?q=${word(9)}`))
    const qMoment = await spy(() => impressions(O, V, `?q=${fixtures[4].name}`))
    const sets = [plain, qAll, qNone, qMoment].map(x => decisions(x.seen))
    check('🔒 the candidates: ONE decision of the 100 most recent moments the viewer is not in, the same set whatever q (none, every row, nothing, a moment\'s name)',
      sets.every(s => s.length === 1 && JSON.stringify(s[0]) === JSON.stringify(first100)), sets.map(s => s.map(x => x.length)))
    check('without q: the candidates statement ran (beside the list)', plain.seen.some(s => CANDIDATES_STMT.test(s.text)) && plain.seen.some(s => LIST_STMT.test(s.text)))
    check('every row of page 1 labelled by the rule (open → momentName, closed → privateMoment)', rowsOf(plain.r).length === 30 && rowsOf(plain.r).every(wantLabel), rowsOf(plain.r).filter(r => !wantLabel(r)).slice(0, 3))
    const label = (r: J) => r.momentName ?? (r.privateMoment ? 'PRIVATE' : null)
    check('🔒 the two paths label alike: the same page without q and with a q every row matches',
      JSON.stringify(rowsOf(plain.r).map(r => [r.id, label(r)])) === JSON.stringify(rowsOf(qAll.r).map(r => [r.id, label(r)])))
    const p2 = await spy(() => impressions(O, V, `?q=${TOKEN}&cursor=${encodeURIComponent(qAll.r.wire.nextCursor)}`))
    check('q across two cursor pages: page 2 labelled by the rule, no row twice, the same candidates',
      rowsOf(p2.r).length === 30 && rowsOf(p2.r).every(wantLabel) && !rowsOf(p2.r).some(r => rowById(qAll.r, r.id))
      && JSON.stringify(decisions(p2.seen)) === JSON.stringify([first100]), [rowsOf(p2.r).length, decisions(p2.seen).map(s => s.length)])
    // 🔒 The name matcher runs only inside the authorised CASE branch (Codex r1 P2).
    const listText = qMoment.seen.find(x => LIST_STMT.test(x.text))?.text ?? ''
    const guardFrom = listText.indexOf('THEN COALESCE(f_unaccent(s.name)'), guardTo = listText.indexOf('ELSE false END', guardFrom)
    const nameAt = [...listText.matchAll(/f_unaccent\(s\.name\)/g)].map(m => m.index!)
    check('🔒 the search\'s moment-name matcher sits ONLY inside the CASE branch an authorised row reaches (both of its uses)',
      guardFrom > 0 && listText.lastIndexOf('CASE WHEN', guardFrom) > 0 && guardTo > guardFrom && nameAt.length === 2 && nameAt.every(i => i >= guardFrom && i < guardTo), { guardFrom, guardTo, nameAt })
    check('q by a candidate moment\'s name: its row found and named', (() => { const r = rowById(qMoment.r, fixtures[4].rating); return rowsOf(qMoment.r).length === 1 && rowShape(r, true, fixtures[4].name) })(), rowsOf(qMoment.r))
    const closedQ = rowsOf(await impressions(O, V, `?q=${fixtures[6].name}`))
    check('q by a closed moment\'s name: not found', closedQ.length === 0, closedQ)
    const old = fixtures[103]
    const oldQ = rowsOf(await impressions(O, V, `?q=${old.name}`))
    check('🔒 a 101st moment (older than the 100, open to the viewer): not found by its name (fails closed)', old.open && oldQ.length === 0, oldQ)
    const top = await spy(() => impressions(O, V, '?sort=highest'))
    const topSets = decisions(top.seen)
    const leftovers = fixtures.slice(100).map(f => f.id).sort((x, y) => x - y)
    check('🔒 a score sort brings the oldest five to page 1: the candidates, then ONE top-up over just those five leftovers, disjoint',
      topSets.length === 2 && JSON.stringify(topSets[0]) === JSON.stringify(first100) && JSON.stringify(topSets[1]) === JSON.stringify(leftovers) && !topSets[1].some(id => first100.includes(id)),
      topSets.map(s => s.length))
    const oldRows = fixtures.slice(100).map(f => rowById(top.r, f.rating))
    check('…and labels them by the rule (the open ones named by the top-up, the closed one private)', oldRows.every(r => !!r && wantLabel(r)), oldRows.map(r => r && label(r)))
    check('…the rest of the page too', rowsOf(top.r).every(wantLabel))
    const closedTop = fixtures.slice(100).filter(f => !f.open)
    check('…the closed leftover is decided in the same top-up and refused: privateMoment', closedTop.length === 1 && closedTop.every(f => rowShape(rowById(top.r, f.rating), false, f.name)))
    // The top-up's own failure (review): the second decision throws, the page is served.
    const topFail = await spy(() => impressions(O, V, '?sort=highest'), { failNth: { on: MOMENTS_STMT, n: 2 } })
    const leftRows = fixtures.slice(100).map(f => rowById(topFail.r, f.rating))
    check('🔒 a failed top-up: 200, the five leftover rows read privateMoment, the rest of the page as before',
      topFail.r.status === 200 && leftRows.every(r => rowShape(r, false, '')) && rowsOf(topFail.r).filter(r => !fixtures.slice(100).some(f => f.rating === r.id)).every(wantLabel),
      [topFail.r.status, leftRows.map(r => r && label(r))])

    // T7: a stripped blind row (owner Incognito in a running blind moment).
    {
      const bname = word(12)
      const Mb = await rawMoment(Hr.id, { visibility: 'verre', name: bname, blind: true, members: [{ id: O.id }] })
      const br = await rawRating(Mb.id, O.id, `${TOKEN} blind`, 4)
      const before = rowById(await impressions(O, V), br)
      check('fixture: the blind row, open moment, not Incognito: blind and named', before?.blind === true && before?.momentName === bname, before)
      await prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${Mb.id}, ${O.id}, true)`
      const after = rowById(await impressions(O, V), br)
      check('🔒 T7: stripped (the owner Incognito there), the blind row reads privateMoment and no momentName', after?.blind === true && rowShape(after, false, bname), after)
      check('…and is not found by the moment\'s name', !rowById(await impressions(O, V, `?q=${bname}`), br))
      await prisma.$executeRaw`DELETE FROM moment_privacy WHERE session_id = ${Mb.id} AND user_id = ${O.id}`
    }

    // ── § 26 g ───────────────────────────────────────────────────────────────
    section('§ 26 g the Incognito race: switched on between the candidates and the list statement')
    {
      const f = fixtures[7]
      check('fixture: the moment is open to the viewer, found by its name', f.open && !!rowById(await impressions(O, V, `?q=${f.name}`), f.rating))
      const raced = await spy(() => impressions(O, V, `?q=${f.name}`), {
        before: { on: LIST_STMT, run: () => prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${f.id}, ${O.id}, true)` },
      })
      const order = raced.seen.map(s => (CANDIDATES_STMT.test(s.text) ? 'C' : MOMENTS_STMT.test(s.text) ? 'D' : LIST_STMT.test(s.text) ? 'L' : '')).filter(Boolean).join('')
      check('the seam ran after the decision (candidates, decision, then the list)', order.startsWith('CD') && order.includes('L'), order)
      check('🔒 the row is NOT found by the moment\'s name (NOT stripped on the open arm, r3 P2)', !rowById(raced.r, f.rating), rowsOf(raced.r))
      const plainRow = rowById(await impressions(O, V), f.rating)
      check('…and without q it reads privateMoment (the strip), never the name', rowShape(plainRow, false, f.name), plainRow)
      await prisma.$executeRaw`DELETE FROM moment_privacy WHERE session_id = ${f.id} AND user_id = ${O.id}`
    }
    {
      // Codex r1 P2: the host narrows the moment AND renames it between the
      // decision and the list statement: the NEW name is never shown or found.
      const f = fixtures[10], newName = `${word(10)} renamed`
      check('fixture: the moment is open to the viewer, found by its name', f.open && !!rowById(await impressions(O, V, `?q=${f.name}`), f.rating))
      const narrow = () => prisma.$executeRaw`UPDATE sessions SET visibility = 'members', name = ${newName} WHERE id = ${f.id}`
      const raced = await spy(() => impressions(O, V, `?q=${encodeURIComponent(newName)}`), { before: { on: LIST_STMT, run: narrow } })
      check('🔒 narrowed and renamed after the decision: NOT found by the new name', !rowById(raced.r, f.rating), rowsOf(raced.r))
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre', name = ${f.name} WHERE id = ${f.id}`
      const racedPlain = await spy(() => impressions(O, V), { before: { on: LIST_STMT, run: narrow } })
      const row = rowById(racedPlain.r, f.rating)
      check('🔒 …and without q the row reads privateMoment, never the new name', rowShape(row, false, newName) && !JSON.stringify(racedPlain.r.wire).includes(newName), row)
      await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre', name = ${f.name} WHERE id = ${f.id}`
      check('…once undone, named again (the control)', rowShape(rowById(await impressions(O, V), f.rating), true, f.name))
    }
  } finally {
    prisma.$queryRaw = orig
    if (saved === undefined) delete process.env.MOMENT_LOOKIN_ENABLED; else process.env.MOMENT_LOOKIN_ENABLED = saved
  }
}
