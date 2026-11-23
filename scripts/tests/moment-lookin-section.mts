// § 24 Moment Visibility, step 1b: who may look in, and the reads
// (docs/dev/proposals/moment-visibility.md § 6–8 / § 10; the step-1 plan § 4.1,
// § 4.3–4.5, § 11 "1b"). Imported by scripts/tests/you-profile-integration.mts
// after § 23 (1a), with the same harness: every response through `call` passes
// the integer canary.
//   § 24 a parity: decideMoments' naming == the single-profile gate
//          (`sees.posts && sees.moments`) for every tier × circle × posts
//          audience × Show Moments × relation × block direction; the grant
//          twins == readGrant
//   § 24 b the audience table: visibility × guests' circles × viewer; a hidden
//          friend and an only-inside member bridge nobody; the 200-person cap
//          fails closed
//   § 24 c the look-in route: ONE 404 for every refusal (bytes and headers),
//          401, the limiter before any lookup, the link vs the audience
//   § 24 d what a look-in shows: the leak matrix (hidden host, nameless
//          moment, Show Moments, blocks, only-inside, kicked, raters without a
//          member row, tombstones, guests in and out of `shown`, place and
//          details, an old code-bearing cover, blind and hidden for the adder)
//   § 24 e the guest reader: bound to the incarnation, the flooded roster, the
//          named cap, the key plan (pure)
//   § 24 f the by-moment read
//   § 24 g someone's Moments: open rows, their filters on hidden people, the
//          counts add up
//   § 24 h the Moments tile's automatic cover; the pin is kept
//   § 24 i the feed and the web profile: momentId, hostName (live, flag off too)
//   § 24 j the canary: no code, no token, no wine or rating id, no identity
import { randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { MomentVisibilityHarness } from './moment-visibility-section.mts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Bare = { id: number; pid: string }
type Res = { status: number; json: J; wire: J; headers: Headers }
type Tier = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual'

const SECRET = 'ci-only-moment-link-secret-0123456789-abcdef'
const PIDRE = /^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$/

export async function momentLookIn(h: MomentVisibilityHarness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, TAG } = h
  const lookInRoute = await import('../../app/api/moments/[publicId]/route.ts')
  const byMomentRoute = await import('../../app/api/me/sessions/by-moment/[publicId]/route.ts')
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const linkRoute = await import('../../app/api/session/[code]/look-in-link/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const usersRoute = await import('../../app/api/users/[id]/route.ts')
  const momentsListRoute = await import('../../app/api/users/[id]/moments/route.ts')
  const { decideMoments, AUDIENCE_PEOPLE_CAP } = await import('../../lib/momentAudience.ts')
  const { planGuestRead, readGuests, readLookInRow, buildLookIn, GUEST_NAMED_MAX } = await import('../../lib/momentLookIn.ts')
  const { resolveProfileViewer } = await import('../../lib/profileVisibility.ts')
  const { readGrant, readGrantByPublicId, grantStatus } = await import('../../lib/sessionGrant.ts')
  const { loadProfile } = await import('../../lib/profileLoad.ts')

  const saved = { flag: process.env.MOMENT_LOOKIN_ENABLED, secret: process.env.MOMENT_LINK_SECRET }
  const flag = (on: boolean) => { if (on) process.env.MOMENT_LOOKIN_ENABLED = 'true'; else delete process.env.MOMENT_LOOKIN_ENABLED }
  const secret = (v: string | null) => { if (v === null) delete process.env.MOMENT_LINK_SECRET; else process.env.MOMENT_LINK_SECRET = v }

  // Fixture people with no session of their own (decided on, never calling).
  let seq = 0
  const bareMany = async (n: number, prefix: string, data: (i: number) => J = () => ({})): Promise<Bare[]> => {
    const emails = Array.from({ length: n }, () => `${TAG}-mv1b-${++seq}@example.test`)
    await prisma.user.createMany({ data: emails.map((email, i) => ({ name: `${prefix} ${i}`, email, ...data(i) })) })
    const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, publicId: true, email: true } }) as J[]
    const by = new Map(rows.map(r => [r.email as string, r]))
    return emails.map(e => ({ id: by.get(e)!.id as number, pid: by.get(e)!.publicId as string }))
  }
  const bare = async (name: string, data: J = {}) => (await bareMany(1, name, () => data))[0]
  const settings = (tier: Tier, o: { fof?: boolean; checkin?: string | null; show?: boolean } = {}) =>
    ({ profileVisibility: tier, visibilityFof: o.fof ?? false, checkinVisibility: o.checkin ?? null, showMoments: o.show ?? true })
  const setSettings = (id: number, tier: Tier, o: { fof?: boolean; checkin?: string | null; show?: boolean } = {}) =>
    prisma.user.update({ where: { id }, data: settings(tier, o) })
  const mutual = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }, { followerId: b, followingId: a }], skipDuplicates: true })
  const follows = (a: number, b: number) => prisma.follow.createMany({ data: [{ followerId: a, followingId: b }], skipDuplicates: true })
  const blocks = (a: number, b: number) => prisma.userBlock.create({ data: { blockerId: a, blockedId: b } })
  const rawCode = () => `MB${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`
  const rawMoment = async (hostId: number | null, o: { visibility?: string; igc?: boolean; name?: string | null; hostName?: string; members?: { id: number; kicked?: boolean }[] } = {}) => {
    const code = rawCode()
    const [r] = await prisma.$queryRaw`
      INSERT INTO sessions (code, host_user_id, host_name, name, created_at, date_from, visibility, include_guest_circles)
      VALUES (${code}, ${hostId}, ${o.hostName ?? 'Raw Host'}, ${o.name === undefined ? `${TAG} raw` : o.name}, now(), now() + interval '1 hour', ${o.visibility ?? 'friends'}, ${o.igc ?? true})
      RETURNING id, public_id` as J[]
    const members = [...(hostId !== null ? [{ id: hostId, role: 'host' }] : []), ...(o.members ?? []).map(m => ({ ...m, role: 'taster' }))]
    if (members.length) await prisma.sessionMember.createMany({ data: members.map(m => ({ userId: m.id, sessionCode: code, role: m.role, removedState: 'kicked' in m && m.kicked ? 'kicked' : null })) })
    return { id: r.id as number, pid: r.public_id as string, code }
  }
  const decide = async (v: number | null, sid: number, o: { everyone?: boolean; also?: number[] } = {}) => (await decideMoments(v, [sid], o)).get(sid)!
  const rowOf = async (code: string): Promise<J> => (await prisma.$queryRaw`SELECT to_jsonb(s) AS j FROM sessions s WHERE code = ${code}` as J[])[0]?.j

  // Every response a NON-member sees, for the code / token canary (§ 24 j).
  const outside: { where: string; text: string }[] = []
  const codes = new Set<string>(), tokens = new Set<string>()
  const seen = (where: string, r: Res) => { outside.push({ where, text: JSON.stringify(r.wire) + [...r.headers.entries()].join() }); return r }
  const lookBodies: J[] = []
  const look = async (pid: string, a: Actor, token?: string, o: { member?: boolean } = {}) => {
    await resetLimits()
    const r = await call(lookInRoute.GET, 'GET', `/api/moments/${pid}`, a, undefined, { publicId: pid }, token !== undefined ? { 'x-verre-link': token } : {})
    if (!o.member) seen(`look-in ${pid}`, r)
    if (r.status === 200 && r.wire?.member === false) lookBodies.push(r.wire)
    return r
  }
  const byMoment = async (pid: string, a: Actor) => {
    await resetLimits()
    return call(byMomentRoute.GET, 'GET', `/api/me/sessions/by-moment/${pid}`, a, undefined, { publicId: pid })
  }
  const join = async (code: string, a: Actor, name = 'Joiner') => {
    await resetLimits()
    const r = await call(joinRoute.POST, 'POST', '/api/session/join', a, { code, displayName: name })
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
    return r
  }
  const rate = async (code: string, a: Actor, wineId: string, score: number, notes = 'n') => {
    await resetLimits()
    const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, a, { wineId, score, flavors: { body: 3 }, notes }, { code })
    if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const share = async (code: string, host: Actor, action = 'share') => {
    await resetLimits()
    const r = await call(linkRoute.POST, 'POST', `/api/session/${code}/look-in-link`, host, { action }, { code })
    const url = r.wire?.link?.url as string | null
    const token = url ? url.slice(url.lastIndexOf('.') + 1) : null
    if (token) tokens.add(token)
    return token
  }
  const noStore = (r: Res) => r.headers.get('cache-control') === 'private, no-store'
  const shape = (r: Res) => JSON.stringify([r.status, r.wire, [...r.headers.entries()].sort()])

  try {
    secret(SECRET)
    flag(true)

    // ── § 24 a parity ───────────────────────────────────────────────────────
    section('§ 24 a parity: decideMoments names exactly whom the single-profile gate shows (posts AND Show Moments)')
    const V = await bare('Vera Viewer', settings('public-users'))
    const X = await bare('Xena Bridge', settings('public-users'))
    await mutual(V.id, X.id)
    const tiers: Tier[] = ['public-internet', 'public-users', 'public-followers', 'public-mutual']
    const rels = ['none', 'v→p', 'p→v', 'mutual', 'circle'] as const
    const blockModes = ['none', 'v blocks', 'p blocks'] as const
    const combos: { fof: boolean; checkin: string | null; show: boolean; rel: typeof rels[number]; block: typeof blockModes[number] }[] = []
    for (const fof of [false, true]) for (const checkin of [null, 'public-followers', 'only-me']) for (const show of [true, false])
      for (const rel of rels) for (const block of blockModes) combos.push({ fof, checkin, show, rel, block })
    let agree = 0, namedN = 0, hiddenN = 0
    const mismatches: J[] = []
    let showOffButPosts = 0, showOffNamed = 0
    for (const tier of tiers) {
      const hostT = await bare(`Pat Host ${tier}`, settings('public-users'))
      const ps = await bareMany(combos.length, `Par ${tier}`, i => settings(tier, combos[i]))
      const follow: { followerId: number; followingId: number }[] = []
      const blk: { blockerId: number; blockedId: number }[] = []
      ps.forEach((p, i) => {
        const c = combos[i]
        if (c.rel === 'v→p' || c.rel === 'mutual') follow.push({ followerId: V.id, followingId: p.id })
        if (c.rel === 'p→v' || c.rel === 'mutual') follow.push({ followerId: p.id, followingId: V.id })
        if (c.rel === 'circle') follow.push({ followerId: X.id, followingId: p.id }, { followerId: p.id, followingId: X.id })
        if (c.block === 'v blocks') blk.push({ blockerId: V.id, blockedId: p.id })
        if (c.block === 'p blocks') blk.push({ blockerId: p.id, blockedId: V.id })
      })
      await prisma.follow.createMany({ data: follow, skipDuplicates: true })
      if (blk.length) await prisma.userBlock.createMany({ data: blk })
      const m = await rawMoment(hostT.id, { members: ps.map(p => ({ id: p.id })) })
      const d = await decide(V.id, m.id, { everyone: true })
      for (const [i, p] of ps.entries()) {
        const g = await resolveProfileViewer(p.id, V.id)
        const expected = g.status === 'ok' && g.sees.posts && g.sees.moments
        if (d.named.has(p.id) === expected) agree++
        else mismatches.push({ tier, ...combos[i], status: g.status, named: d.named.has(p.id) })
        if (expected) namedN++; else hiddenN++
        if (g.status === 'ok' && g.sees.posts && !combos[i].show) { showOffButPosts++; if (d.named.has(p.id)) showOffNamed++ }
      }
    }
    check(`naming == resolveProfileViewer(…).sees.posts && sees.moments for ${agree + mismatches.length} people (4 tiers × circle × posts audience × Show Moments × 5 relations × 3 block directions)`,
      mismatches.length === 0 && agree === tiers.length * combos.length, mismatches.slice(0, 8))
    check('…not vacuous: both outcomes occur in numbers', namedN > 40 && hiddenN > 200, { namedN, hiddenN })
    check('🔒 negative control: Show Moments is load-bearing (people whose posts the viewer may see, Show Moments off) and none of them is named', showOffButPosts > 20 && showOffNamed === 0, { showOffButPosts, showOffNamed })
    const selfM = await rawMoment(X.id, { members: [{ id: V.id }] })
    const selfD = await decide(V.id, selfM.id, { everyone: true })
    check('a member is `member`, never `open`, and nobody is evaluated for them (a member sees the moment itself)', selfD.member && !selfD.open && selfD.named.size === 0 && !selfD.hostNamed, selfD)
    const signedOut = await decide(null, selfM.id, { everyone: true })
    check('a signed-out reader: never a member, never open; named only by public-internet people', !signedOut.member && !signedOut.open && !signedOut.named.has(V.id) && !signedOut.named.has(X.id))

    // The grant twins read the same rule as the moment itself.
    const Hg = await mkUser('Gwen Granthost'), Mg = await mkUser('Mo Grantmember'), Kg = await mkUser('Kim Grantkicked'), Sg = await mkUser('Sam Grantstranger')
    const G = await createSession(Hg, 'Gwen Granthost')
    await join(G, Mg); await join(G, Kg)
    await prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE session_code = ${G} AND user_id = ${Kg.id}`
    const gRow = await rowOf(G)
    codes.add(G)
    const twins = []
    for (const u of [Hg, Mg, Kg, Sg]) {
      const a = await readGrant(prisma, G, u.id), b = await readGrantByPublicId(prisma, gRow.public_id, u.id)
      const c = (await decideMoments(u.id, [gRow.id])).get(gRow.id)!
      twins.push(JSON.stringify(a) === JSON.stringify(b?.grant) && b?.code === G && c.member === (grantStatus(a!) === 'ok'))
    }
    check('readGrantByPublicId == readGrant, and decideMoments\' member == grantStatus(…) === \'ok\' (host, member, kicked, stranger)', twins.every(Boolean), twins)

    // ── § 24 b the audience table ───────────────────────────────────────────
    section('§ 24 b who may look in: visibility × guests\' circles × viewer')
    const pub = settings('public-users')
    const [Ha, Ba, Hid, Oi, Mem] = await Promise.all([bare('Hal Audhost', pub), bare('Bo Bridge', pub), bare('Hidi Hidden', settings('public-users', { show: false })), bare('Oli Inside', pub), bare('Meg Member', pub)])
    const vw: Record<string, Bare> = {}
    for (const name of ['hostFriend', 'hostFollower', 'bridgeFriend', 'bridgeFollower', 'hiddenFriend', 'insideFriend', 'stranger', 'kicked', 'banned', 'blockedByHost', 'blocksHost', 'member'])
      vw[name] = await bare(`View ${name}`, pub)
    await mutual(vw.hostFriend.id, Ha.id); await follows(vw.hostFollower.id, Ha.id)
    await mutual(vw.bridgeFriend.id, Ba.id); await follows(vw.bridgeFollower.id, Ba.id)
    await mutual(vw.hiddenFriend.id, Hid.id); await mutual(vw.insideFriend.id, Oi.id)
    for (const n of ['kicked', 'banned', 'blockedByHost', 'blocksHost']) await mutual(vw[n].id, Ha.id)
    await blocks(Ha.id, vw.blockedByHost.id); await blocks(vw.blocksHost.id, Ha.id)
    const A = await rawMoment(Ha.id, { members: [{ id: Ba.id }, { id: Hid.id }, { id: Oi.id }, { id: Mem.id }, { id: vw.member.id }, { id: vw.kicked.id, kicked: true }] })
    await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${A.code}, ${`u:${vw.banned.id}`})`
    await prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${A.id}, ${Oi.id}, true)`
    const refusedSet = ['banned', 'blockedByHost', 'blocksHost']
    const expectOpen = (vis: string, igc: boolean, n: string): boolean => {
      if (n === 'member' || refusedSet.includes(n) || vis === 'members') return false
      if (vis === 'verre') return true
      const direct = vis === 'friends' ? ['hostFriend', 'kicked'] : ['hostFriend', 'hostFollower', 'kicked']
      const bridged = !igc ? [] : vis === 'friends' ? ['bridgeFriend'] : ['bridgeFriend', 'bridgeFollower']
      return direct.includes(n) || bridged.includes(n)
    }
    const table: J[] = []
    for (const vis of ['members', 'friends', 'followers', 'verre']) for (const igc of [false, true]) {
      await prisma.$executeRaw`UPDATE sessions SET visibility = ${vis}, include_guest_circles = ${igc} WHERE id = ${A.id}`
      for (const [n, u] of Object.entries(vw)) {
        const d = await decide(u.id, A.id)
        if (d.open !== expectOpen(vis, igc, n)) table.push({ vis, igc, viewer: n, open: d.open })
      }
    }
    check('🔒 every visibility × guests\' circles × viewer (host\'s friend / follower, a member\'s friend / follower, stranger, kicked, banned, blocked by / blocking the host, a member) as the table says', table.length === 0, table)
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends', include_guest_circles = true WHERE id = ${A.id}`
    const dHid = await decide(vw.hiddenFriend.id, A.id, { everyone: true }), dOi = await decide(vw.insideFriend.id, A.id, { everyone: true })
    check('🔒 a hidden friend (Show Moments off) bridges nobody and is not named', !dHid.open && !dHid.named.has(Hid.id), dHid)
    check('🔒 an only-inside member (a raw moment_privacy row) bridges nobody and is not named', !dOi.open && !dOi.named.has(Oi.id), dOi)
    check('…the same friend bridges once they show (the negative control of the two above)', await (async () => {
      await setSettings(Hid.id, 'public-users', { show: true })
      const ok = (await decide(vw.hiddenFriend.id, A.id)).open
      await setSettings(Hid.id, 'public-users', { show: false })
      return ok
    })())
    flag(false)
    check('🔒 flag off: nobody is admitted (the hostName rule still decides)', !(await decide(vw.hostFriend.id, A.id)).open && (await decide(vw.hostFriend.id, A.id)).hostNamed)
    flag(true)
    // The cap: the first 200 people in the fill order are hidden bridges; the
    // one visible friend sorts after them.
    const Vc = await bare('Cap Viewer', pub), Hc = await bare('Cap Host', settings('public-users', { show: false }))
    const cap = await bareMany(AUDIENCE_PEOPLE_CAP + 1, 'Cap Bridge', () => settings('public-users', { show: false }))
    const last = cap.reduce((a, b) => (a.id > b.id ? a : b))
    await setSettings(last.id, 'public-users')
    await prisma.follow.createMany({ data: cap.flatMap(p => [{ followerId: Vc.id, followingId: p.id }, { followerId: p.id, followingId: Vc.id }]) })
    const C = await rawMoment(Hc.id, { members: cap.map(p => ({ id: p.id })) })
    const dc = await decide(Vc.id, C.id, { everyone: true })
    check(`🔒 the cap (${AUDIENCE_PEOPLE_CAP} people per call) fails closed: the visible friend past it is not named and admits nobody`, !dc.open && !dc.named.has(last.id) && dc.named.size === 0, { open: dc.open, named: dc.named.size })
    await prisma.sessionMember.deleteMany({ where: { sessionCode: C.code, userId: { in: cap.filter(p => p.id !== last.id).slice(0, 2).map(p => p.id) } } })
    const dc2 = await decide(Vc.id, C.id, { everyone: true })
    check('…two fewer people and the same friend is named and admits (the cap is what refused)', dc2.open && dc2.named.has(last.id), { open: dc2.open, named: dc2.named.size })
    // Asking about someone (a list's owner, a filter's friend) costs a slot
    // whether they are in the moments or not, so their presence moves nothing.
    const Fq = await bare('Fay Asked', pub)
    const absent = (await decide(Vc.id, C.id, { everyone: true, also: [Fq.id] })).open
    await prisma.sessionMember.create({ data: { userId: Fq.id, sessionCode: C.code } })
    const presentNow = (await decide(Vc.id, C.id, { everyone: true, also: [Fq.id] })).open
    await prisma.sessionMember.deleteMany({ where: { sessionCode: C.code, userId: Fq.id } })
    check('🔒 a person asked about takes their slot whether or not they are in it: the answer is the same (no presence oracle)', absent === presentNow && !absent && dc2.open, { absent, presentNow })
    // A hostless moment (its host deleted their account): no host circle.
    const Vh = await bare('Hal Hostlessviewer', pub), Bhl = await bare('Bea Hostlessbridge', pub)
    await mutual(Vh.id, Bhl.id)
    const HL = await rawMoment(null, { members: [{ id: Bhl.id }] })
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${HL.id}`
    const hlVerre = [await decide(Vh.id, HL.id), await decide(X.id, HL.id)]
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'friends', include_guest_circles = true WHERE id = ${HL.id}`
    const hlFriends = [await decide(Vh.id, HL.id), await decide(X.id, HL.id)]
    check('a hostless moment by audience: Everyone admits anyone; Your Friends only through a named member; no host is named',
      hlVerre.every(d => d.open) && hlFriends[0].open && !hlFriends[1].open && [...hlVerre, ...hlFriends].every(d => !d.hostNamed && d.hostUserId === null), [...hlVerre, ...hlFriends].map(d => d.open))

    // ── § 24 c the look-in route ────────────────────────────────────────────
    section('§ 24 c GET /api/moments/:publicId: one 404, 401, the limiter first, the link vs the audience')
    const Hl = await mkUser('Lena Lookhost'), Ml = await mkUser('Milo Member'), Ol = await mkUser('Ola Outsider'), Sl = await mkUser('Sven Stranger')
    const Bl = await mkUser('Bert Banned'), Bh = await mkUser('Bianca Blockedbyhost'), Kl = await mkUser('Karl Kicked')
    for (const u of [Ol, Bl, Bh, Kl]) await mutual(u.id, Hl.id)
    await blocks(Hl.id, Bh.id)
    const L = await createSession(Hl, 'Lena Lookhost')
    codes.add(L)
    await join(L, Ml); await join(L, Kl)
    const lRow = await rowOf(L)
    await prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE session_code = ${L} AND user_id = ${Kl.id}`
    await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${L}, ${`u:${Bl.id}`})`
    const ok = await look(lRow.public_id, Ol)
    check('an admitted outsider (the host\'s friend, Friends by default) gets the look-in, no-store', ok.status === 200 && ok.wire.member === false && ok.wire.moment?.id === lRow.public_id && noStore(ok), ok.wire)
    const mem = await look(lRow.public_id, Ml, undefined, { member: true }), hostSelf = await look(lRow.public_id, Hl, undefined, { member: true })
    check('a member and the strict host: { member: true } and nothing else', [mem, hostSelf].every(r => r.status === 200 && JSON.stringify(r.wire) === '{"member":true}' && noStore(r)), [mem.wire, hostSelf.wire])
    const kick = await look(lRow.public_id, Kl)
    check('a kicked viewer is an outsider like anyone (the host\'s friend: admitted)', kick.status === 200 && kick.wire.member === false, kick.wire)
    const tok = (await share(L, Hl))!
    // Refusals.
    const D = await createSession(Hl, 'Lena Lookhost'); codes.add(D)
    const dPid = (await rowOf(D)).public_id
    await resetLimits()
    await call(codeRoute.DELETE, 'DELETE', `/api/session/${D}`, Hl, undefined, { code: D })
    const N = await createSession(Hl, 'Lena Lookhost'); codes.add(N)
    const nRow = await rowOf(N)
    await prisma.$executeRaw`UPDATE sessions SET visibility = NULL WHERE id = ${nRow.id}`
    const hostless = await rawMoment(null, { visibility: 'verre' })
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre', link_version = 1, link_active = true WHERE id = ${hostless.id}`
    const { momentLinkToken } = await import('../../lib/momentLink.ts')
    const hostlessTok = momentLinkToken(hostless.pid, 1)!
    tokens.add(hostlessTok)
    const unknown = 'ZZZZZZZZZZZZ'
    const refusals: [string, () => Promise<Res>][] = [
      ['malformed id', () => look('not-a-moment', Ol)],
      ['malformed token', () => look(lRow.public_id, Sl, 'zz')],
      ['empty token', () => look(lRow.public_id, Sl, '')],
      ['unknown id', () => look(unknown, Ol)],
      ['unknown id with a token', () => look(unknown, Ol, tok)],
      ['a deleted moment', () => look(dPid, Ol)],
      ['visibility NULL', () => look(nRow.public_id, Ol)],
      ['not admitted (a stranger, Friends)', () => look(lRow.public_id, Sl)],
      ['banned', () => look(lRow.public_id, Bl)],
      ['banned, with the valid link', () => look(lRow.public_id, Bl, tok)],
      ['blocked by the host', () => look(lRow.public_id, Bh)],
      ['blocked by the host, with the valid link', () => look(lRow.public_id, Bh, tok)],
      ['a wrong token', () => look(lRow.public_id, Sl, randomUUID().replace(/-/g, ''))],
      ['a member with a dead link', () => look(lRow.public_id, Ml, randomUUID().replace(/-/g, ''), { member: true })],
      ['a hostless moment by link', () => look(hostless.pid, Sl, hostlessTok)],
    ]
    const ans: [string, Res][] = []
    for (const [label, f] of refusals) ans.push([label, await f()])
    // The link turned off, reset, and the secret gone.
    await share(L, Hl, 'off'); ans.push(['the link turned off', await look(lRow.public_id, Sl, tok)])
    const tok2 = (await share(L, Hl))!
    await share(L, Hl, 'reset'); ans.push(['the old token after a reset', await look(lRow.public_id, Sl, tok2)])
    const tok3 = (await rowOf(L)).link_active ? momentLinkToken(lRow.public_id, (await rowOf(L)).link_version)! : ''
    tokens.add(tok3)
    secret(null); ans.push(['the secret absent', await look(lRow.public_id, Sl, tok3)]); secret(SECRET)
    flag(false); ans.push(['the flag off', await look(lRow.public_id, Ol)]); flag(true)
    const ref = shape(ans[0][1])
    check(`🔒 ONE refusal: ${ans.length} cases answer the same 404 { error: "not found" }, byte for byte with the same headers`,
      ans.every(([, r]) => shape(r) === ref) && ans[0][1].status === 404 && JSON.stringify(ans[0][1].wire) === '{"error":"not found"}' && noStore(ans[0][1]),
      ans.filter(([, r]) => shape(r) !== ref).map(([l, r]) => [l, r.status, r.wire]))
    const viaLink = await look(lRow.public_id, Sl, tok3)
    check('a valid link admits a stranger the audience refuses', viaLink.status === 200 && viaLink.wire.member === false, viaLink.wire)
    const memLink = await look(lRow.public_id, Ml, tok3, { member: true })
    check('…and a member with the valid link gets { member: true }', JSON.stringify(memLink.wire) === '{"member":true}', memLink.wire)
    const kickLink = await look(lRow.public_id, Kl, tok3)
    check('…and a kicked viewer with it (the link skips the audience)', kickLink.status === 200 && kickLink.wire.member === false)
    const out401 = [await look(lRow.public_id, {}), await look(unknown, {}), await look('bad', {}), await look(lRow.public_id, {}, tok3)]
    check('signed out: the same 401 { error: "auth required" } for every id and token', out401.every(r => r.status === 401 && shape(r) === shape(out401[0]) && r.wire.error === 'auth required'), out401.map(r => [r.status, r.wire]))
    await blocks(Ml.id, Hl.id)
    const memBlock = await look(lRow.public_id, Ml, undefined, { member: true }), memBlockBm = await byMoment(lRow.public_id, Ml)
    await prisma.userBlock.deleteMany({ where: { blockerId: Ml.id, blockedId: Hl.id } })
    check('a member in a block pair with the host: { member: true }, as by-moment answers them (the two never disagree)',
      JSON.stringify(memBlock.wire) === '{"member":true}' && memBlockBm.status === 200 && memBlockBm.wire.code === L, [memBlock.wire, memBlockBm.status])
    // The limiter runs before any lookup: a spent budget runs no query.
    const sqls: string[] = []
    const orig = prisma.$queryRaw
    let spied = false
    try {
      prisma.$queryRaw = (...a: unknown[]) => { sqls.push(Array.isArray(a[0]) ? (a[0] as string[]).join('?') : String(a[0])); return orig.apply(prisma, a) }
      spied = true
    } catch { /* a client that refuses the spy: the 429s below still hold */ }
    await resetLimits()
    await redis.set(`rl:lookin:u:${Ol.id}:1m`, '60', { EX: 60 })
    const spent = [
      await call(lookInRoute.GET, 'GET', `/api/moments/${lRow.public_id}`, Ol, undefined, { publicId: lRow.public_id }),
      await call(lookInRoute.GET, 'GET', `/api/moments/${unknown}`, Ol, undefined, { publicId: unknown }),
      await call(lookInRoute.GET, 'GET', '/api/moments/bad', Ol, undefined, { publicId: 'bad' }),
    ]
    if (spied) prisma.$queryRaw = orig
    check('🔒 a spent per-user budget (60/min): 429 + Retry-After for a real, an unknown and a malformed id alike', spent.every(r => r.status === 429 && !!r.headers.get('retry-after') && noStore(r) && r.wire.error === 'Too many requests'), spent.map(r => [r.status, r.wire]))
    check('🔒 …and no moment was looked up (the limiter sits before the row read)', spied && !sqls.some(s => /FROM sessions s/.test(s) && /public_id/.test(s)), { spied, sqls: sqls.map(s => s.slice(0, 80)) })
    await resetLimits()
    await redis.set('rl:lookin:ip:10.77.0.9:1m', '600', { EX: 60 })
    const ipSpent = await call(lookInRoute.GET, 'GET', `/api/moments/${lRow.public_id}`, Ol, undefined, { publicId: lRow.public_id }, { 'x-forwarded-for': '10.77.0.9' })
    const ipOther = await call(lookInRoute.GET, 'GET', `/api/moments/${lRow.public_id}`, Ol, undefined, { publicId: lRow.public_id }, { 'x-forwarded-for': '10.77.0.10' })
    check('the per-address backstop (600/min)', ipSpent.status === 429 && ipOther.status === 200, [ipSpent.status, ipOther.status])
    await resetLimits()

    // ── § 24 d what a look-in shows ─────────────────────────────────────────
    section('§ 24 d what a look-in shows: the leak matrix')
    const Hm = await mkUser('Hedda Hiddenhost'), Pn = await mkUser('Nora Named'), Ps = await mkUser('Sid Showsnot'), Pb = await mkUser('Bea Blocksyou')
    const Po = await mkUser('Otto Onlyinside'), Pk = await mkUser('Kurt Kickkeep'), Pr = await mkUser('Rita Raterleft'), Vm = await mkUser('Viktor Looker')
    await setSettings(Hm.id, 'public-users', { show: false })
    await setSettings(Ps.id, 'public-users', { show: false })
    for (const u of [Pn, Pb, Po, Pk, Pr]) await setSettings(u.id, 'public-users')
    await setSettings(Vm.id, 'public-users')
    await blocks(Pb.id, Vm.id)
    const S = await createSession(Hm, 'Hedda Hiddenhost'); codes.add(S)
    const sRow0 = await rowOf(S)
    for (const u of [Pn, Ps, Pb, Po, Pk, Pr]) await join(S, u)
    // Added by the host, the bringers set in the record (tasters can't add).
    const w1 = await addWine(S, Hm, `${TAG} Named Bottle`)
    const w2 = await addWine(S, Hm, `${TAG} Hidden Bringer Bottle`)
    const w3 = await addWine(S, Hm, `${TAG} Blind Label`)
    const wineIds = [w1.id, w2.id, w3.id]
    for (const [w, u] of [[w1, Pn], [w2, Ps], [w3, Pk]] as const) await prisma.$executeRaw`UPDATE wines SET added_by_identity_id = ${`u:${u.id}`} WHERE id = ${w.id}`
    const g1 = await join(S, {}, 'Gina Shown'), g2 = await join(S, {}, 'Gus Hidden')
    const G1: Actor = { anon: g1.wire.anonToken }, G2: Actor = { anon: g2.wire.anonToken }
    await redis.sRem(k.shown(S), String(g2.wire.id))
    const scores: [Actor, string, number][] = [[Pn, w1.id, 4], [Ps, w1.id, 2], [Pb, w1.id, 3], [Po, w1.id, 5], [Pk, w1.id, 1], [Pr, w1.id, 3.5], [G1, w1.id, 4.5], [G2, w1.id, 2.5],
      [Pn, w3.id, 3], [G1, w3.id, 4], [Pn, w2.id, 0]]
    for (const [a, w, s] of scores) await rate(S, a, w, s, `note ${s}`)
    await prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE session_code = ${S} AND user_id = ${Pk.id}`
    await prisma.$executeRaw`DELETE FROM session_members WHERE session_code = ${S} AND user_id = ${Pr.id}`
    await prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${sRow0.id}, ${Po.id}, true)`
    const tomb = `d:${randomUUID()}`
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at, tombstone_key)
      VALUES (${w1.id}, NULL, ${sRow0.id}, 'session', '[deleted]', 1.5, now(), ${tomb})`
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre', blind = true WHERE id = ${sRow0.id}`
    await prisma.$executeRaw`UPDATE wines SET revealed_at = now() WHERE id IN (${w1.id}, ${w2.id})`
    // Nora's photos on a revealed and on the blind bottle; her w1 rating stores an
    // extra aroma field, a stray entry and a non-number structure value.
    await prisma.$executeRaw`INSERT INTO rating_images (rating_id, image_url, sort_order)
      SELECT id, 'https://s3.example.test/verre/ratings/' || wine_id || '_nora.png', 0 FROM ratings
       WHERE session_id = ${sRow0.id} AND user_id = ${Pn.id} AND wine_id IN (${w1.id}, ${w3.id})`
    await prisma.$executeRaw`UPDATE ratings SET aromas = '[{"a":"fruity","m":null,"x":"leak-marker"},{"a":"spicy.pepper","m":"fresh","p":true},"junk"]'::jsonb,
      flavors = '{"body":3,"x":"leak-marker"}'::jsonb WHERE session_id = ${sRow0.id} AND user_id = ${Pn.id} AND wine_id = ${w1.id}`
    const ratingIds = (await prisma.$queryRaw`SELECT id FROM ratings WHERE session_id = ${sRow0.id}` as J[]).map(r => Number(r.id))
    const lk = await look(sRow0.public_id, Vm)
    const b = lk.wire
    check('fixture: the looker is admitted (Everyone on Verre)', lk.status === 200 && b.member === false, b)
    check('🔒 a hidden host (Show Moments off): no host line', b.moment?.host === null)
    const namedNames = (b.people?.named ?? []).map((p: J) => p.name)
    check('🔒 named: only the member who shows to you (and the shown guest); hidden, blocking, only-inside, kick-keep, a rater who left and a deleted account are not',
      JSON.stringify(namedNames.sort()) === JSON.stringify(['Gina Shown', 'Nora Named'].sort()), namedNames)
    // Counted: host, Pn, Ps, Pb, Po, Pr (a rater without a member row), the tombstone, two guests. Not Pk (kick-keep).
    check('people.total: the room\'s roster (host, four members, a rater who left, a deleted account, two guests; the kick-keep rater out), the same for every viewer',
      b.people?.total === 9 && b.people.more === 7, b.people)
    const reg = (b.people.named as J[]).find(p => p.name === 'Nora Named'), gst = (b.people.named as J[]).find(p => p.guest)
    check('a named person: the public id, name and photo; a named guest: name only, guest: true, no id', reg?.id === Pn.pid && 'imageUrl' in reg && gst?.name === 'Gina Shown' && !('id' in gst) && gst.guest === true, b.people.named)
    const row1 = (b.lineup as J[])[0], row2 = (b.lineup as J[])[1], row3 = (b.lineup as J[])[2]
    // w1: Pn 4, Ps 2, Pb 3, Po 5, Pr 3.5, tombstone 1.5, G1 4.5, G2 2.5 (Pk's 1 out).
    const avg1 = Math.round(((4 + 2 + 3 + 5 + 3.5 + 1.5 + 4.5 + 2.5) / 8) * 100) / 100
    check('averages: every counted rater above 0 (hidden people and the hidden guest included; the kick-keep rater out)', row1?.avg === avg1 && row1.count === 8, row1)
    check('a score of 0 is not a rating (an empty average)', row2?.avg === null && row2.count === 0, row2)
    check('Brought By: the named bringer shows; a hidden bringer is null', row1?.broughtBy?.id === Pn.pid && row1.broughtBy.name === 'Nora Named' && row2?.broughtBy === null, [row1?.broughtBy, row2?.broughtBy])
    check('🔒 the unrevealed bottle is a blind row: no name, producer, photo or catalogue field', row3?.blind === true && JSON.stringify(Object.keys(row3).sort()) === JSON.stringify(['avg', 'blind', 'colour', 'count', 'position', 'sparkling']), row3)
    check('positions are this output\'s indexes', (b.lineup as J[]).map((r: J) => r.position).join() === '0,1,2')
    const mine = (b.ratings as J[])
    check('ratings: only the named people\'s (Nora on all three, the shown guest on two), keyed by person and position',
      mine.length === 5 && mine.every(r => ['p0', 'g0'].includes(r.person)) && mine.filter(r => r.person === 'g0').length === 2, mine)
    const nora0 = mine.find(r => r.person === 'p0' && r.position === 0), nora2 = mine.find(r => r.person === 'p0' && r.position === 2)
    check('a named person\'s rating photo shows on a revealed bottle', typeof nora0?.imageUrl === 'string' && nora0.imageUrl.endsWith('_nora.png'), nora0)
    check('🔒 a rating on the blind row carries its score and notes but no photo (Nora has one there)',
      !!nora2 && typeof nora2.score === 'number' && typeof nora2.notes === 'string' && mine.filter(r => r.position === 2).every(r => !('imageUrl' in r)), nora2)
    check('🔒 stored aromas and structure are projected to their known fields (an extra field, a stray entry, a non-number value: out)',
      JSON.stringify(nora0?.aromas) === JSON.stringify([{ a: 'fruity', m: null }, { a: 'spicy.pepper', m: 'fresh', p: true }]) && JSON.stringify(nora0?.flavors) === '{"body":3}' && !JSON.stringify(b).includes('leak-marker'), nora0)
    check('place and details off: no timezone, address, description or link key', !['timezone', 'address', 'description', 'link'].some(f => f in b.moment), b.moment)
    await prisma.$executeRaw`UPDATE sessions SET show_place = true, show_details = true, address = 'Somewhere 1', description = 'About', link = 'https://example.test' WHERE id = ${sRow0.id}`
    const lk2 = (await look(sRow0.public_id, Vm)).wire
    check('place and details on: timezone + address, description + link', lk2.moment.address === 'Somewhere 1' && 'timezone' in lk2.moment && lk2.moment.description === 'About' && lk2.moment.link === 'https://example.test', lk2.moment)
    await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${`https://s3.example.test/verre/sessions/${S}_123.png`} WHERE id = ${sRow0.id}`
    check('🔒 an old cover whose key carries the code is dropped', (await look(sRow0.public_id, Vm)).wire.moment.coverPhotoUrl === null)
    await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = 'https://s3.example.test/verre/covers/abc_1.png' WHERE id = ${sRow0.id}`
    check('…a current one is kept', (await look(sRow0.public_id, Vm)).wire.moment.coverPhotoUrl === 'https://s3.example.test/verre/covers/abc_1.png')
    await prisma.$executeRaw`UPDATE sessions SET name = NULL, host_name = 'Hedda Hiddenhost' WHERE id = ${sRow0.id}`
    check('🔒 a nameless old moment with a hidden host: no name (never the host\'s)', (await look(sRow0.public_id, Vm)).wire.moment.name === null)
    await setSettings(Hm.id, 'public-users')
    const shownHost = (await look(sRow0.public_id, Vm)).wire
    check('…once the host shows: the host line, and the nameless moment reads as the host\'s name', shownHost.moment.host?.id === Hm.pid && shownHost.moment.name === 'Hedda Hiddenhost', shownHost.moment)
    await setSettings(Hm.id, 'public-users', { show: false })
    // The adder of the blind bottle, kicked, looks in: no bypass.
    const adder = (await look(sRow0.public_id, Pk)).wire
    check('🔒 an outsider who ADDED the blind bottle still sees it blind (no adder bypass outside the moment)', (adder.lineup as J[])?.[2]?.blind === true && !JSON.stringify(adder).includes(`${TAG} Blind Label`), adder.lineup)
    await prisma.$executeRaw`UPDATE sessions SET hide_lineup = true, hide_lineup_minutes_before = 0, date_from = now() + interval '2 hours' WHERE id = ${sRow0.id}`
    const hid = (await look(sRow0.public_id, Vm)).wire, hidAdder = (await look(sRow0.public_id, Pk)).wire
    check('🔒 a hidden line-up: lineupHidden, no bottle and no rating (the looker and the kicked adder alike); people still counted',
      [hid, hidAdder].every(x => x.lineupHidden === true && x.lineup.length === 0 && x.ratings.length === 0 && x.people.total === 9), [hid.lineup, hid.ratings, hidAdder.lineup])
    await prisma.$executeRaw`UPDATE sessions SET hide_lineup = false WHERE id = ${sRow0.id}`
    // Guests: a lost `shown` key hides the guest who was shown.
    await redis.del(k.shown(S))
    const lost = (await look(sRow0.public_id, Vm)).wire
    check('🔒 a lost shown key: no guest is named; both still counted, their scores still in the average', !(lost.people.named as J[]).some(p => p.guest) && lost.people.total === 9 && (lost.lineup as J[])[0].count === 8, lost.people)
    await redis.sAdd(k.shown(S), String(g1.wire.id))

    // ── § 24 e the guest reader ─────────────────────────────────────────────
    section('§ 24 e the guest reader: one script, bound to the incarnation, bounded')
    const created = (await prisma.$queryRaw`SELECT created_at FROM sessions WHERE id = ${sRow0.id}` as J[])[0].created_at as Date
    check('the guests of this incarnation', (await readGuests(S, created))?.length === 2)
    check('🔒 a code deleted and reused in between (another created_at): no guests', (await readGuests(S, new Date(created.getTime() + 1000))) === null)
    check('🔒 a row without created_at cannot be bound: no guests', (await readGuests(S, null)) === null)
    await prisma.$executeRaw`UPDATE sessions SET created_at = created_at + interval '1 second' WHERE id = ${sRow0.id}`
    const other = (await look(sRow0.public_id, Vm)).wire
    check('🔒 …through the route: the row and the cached meta disagree → no guest named or counted', !(other.people.named as J[]).some(p => p.guest) && other.people.total === 7, other.people)
    await prisma.$executeRaw`UPDATE sessions SET created_at = ${created} WHERE id = ${sRow0.id}`
    // A guest rating key that holds a bare JSON null is skipped, never a 500.
    const nullKey = k.rating(S, String(g2.wire.id), w2.id)
    await redis.set(nullKey, 'null', { KEEPTTL: true })
    const nullRead = await look(sRow0.public_id, Vm)
    await redis.del(nullKey)
    check('a guest rating key holding null is skipped (the look-in still answers)', nullRead.status === 200 && nullRead.wire.member === false, [nullRead.status, nullRead.wire?.error])
    // 🔒 The room is read by code: if the code moves to another moment (or the
    // moment goes) while it is read, the look-in is the one 404, never a mix.
    const rowNow = (await readLookInRow(sRow0.public_id))!, dNow = await decide(Vm.id, sRow0.id, { everyone: true })
    await prisma.$executeRaw`UPDATE sessions SET code = ${`${S}X`} WHERE id = ${sRow0.id}`
    const moved = await buildLookIn(rowNow, dNow)
    await prisma.$executeRaw`UPDATE sessions SET code = ${S} WHERE id = ${sRow0.id}`
    const back = await buildLookIn(rowNow, dNow)
    check('🔒 the code moved while the moment was read: no body (the route answers 404); back in place: the body', moved === null && back !== null && back.moment.id === sRow0.public_id)
    const metaRaw = await redis.get(k.meta(S))
    await redis.del(k.meta(S))
    check('no cached meta: no guests (the look-in never rebuilds)', (await readGuests(S, created)) === null && (await redis.get(k.meta(S))) === null)
    await redis.set(k.meta(S), metaRaw!, { KEEPTTL: true })
    // A flooded roster, with the line-up hidden.
    const F = await createSession(Hl, 'Lena Lookhost'); codes.add(F)
    const fRow = await rowOf(F)
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre', hide_lineup = true, hide_lineup_minutes_before = 0 WHERE id = ${fRow.id}`
    const fake = (n: number) => Array.from({ length: n }, () => `a:${randomUUID()}`)
    const flood = fake(501)
    await redis.hSet(k.identities(F), Object.fromEntries(flood.map((id, i) => [id, `Flood ${i}`])))
    await redis.sAdd(k.shown(F), flood)
    const fl = (await look(fRow.public_id, Sl)).wire
    check('🔒 a roster of 501 (and a hidden line-up): no guest named or counted, the same for everyone', fl.lineupHidden === true && !(fl.people.named as J[]).some(p => p.guest) && fl.people.total === 1, fl.people)
    await redis.del(k.identities(F)); await redis.del(k.shown(F))
    const hundred = fake(101)
    await redis.hSet(k.identities(F), Object.fromEntries(hundred.map((id, i) => [id, `Guest ${i}`])))
    await redis.sAdd(k.shown(F), hundred)
    const many = (await look(fRow.public_id, Sl)).wire
    check(`guest ${GUEST_NAMED_MAX + 1} is counted, not named`, (many.people.named as J[]).filter(p => p.guest).length === GUEST_NAMED_MAX && many.people.total === 102, { named: many.people.named.length, total: many.people.total })
    const guests = hundred.map(id => ({ id, name: 'x', shown: true }))
    const none = planGuestRead(F, guests, [])
    check('the key plan (pure): a hidden line-up reads no rating key', none.keys.length === 0 && none.counted === 101 && none.named.length === GUEST_NAMED_MAX)
    const some = planGuestRead(F, guests.slice(0, 3), ['w1', 'w2'])
    check('…only the surviving bottles, one key per guest and bottle, in identity order', some.keys.length === 6 && some.keys.every(key => key.startsWith(`s:${F}:r:a:`) && /:w[12]$/.test(key)) && some.keys[0] < some.keys[2])
    const big = planGuestRead(F, fake(400).map(id => ({ id, name: 'x', shown: true })), Array.from({ length: 30 }, (_, i) => `w${i}`))
    check('…at most 2,000 keys; a guest whose keys don\'t fit is counted, never named', big.keys.length <= 2000 && big.read.length === 66 && big.named.length === 66 && big.counted === 400, { keys: big.keys.length, read: big.read.length })

    // ── § 24 f by-moment ────────────────────────────────────────────────────
    section('§ 24 f GET /api/me/sessions/by-moment/:publicId')
    const bm = [await byMoment(lRow.public_id, Ml), await byMoment(lRow.public_id, Hl), await byMoment(sRow0.public_id, Pr)]
    check('a member, the strict host and a rater without a member row: { id, code }', bm.every(r => r.status === 200 && typeof r.wire.code === 'string' && Number.isInteger(r.wire.id)) && bm[0].wire.code === L && bm[2].wire.code === S && noStore(bm[0]), bm.map(r => r.wire))
    const bmNo = [await byMoment(lRow.public_id, Kl), await byMoment(lRow.public_id, Bl), await byMoment(lRow.public_id, Sl), await byMoment(unknown, Ml), await byMoment('bad', Ml), await byMoment(sRow0.public_id, Pk)]
    flag(false); bmNo.push(await byMoment(lRow.public_id, Ml)); flag(true)
    for (const r of bmNo) seen('by-moment refusal', r)
    check('🔒 kicked, banned, a stranger, unknown, malformed, a kick-keep rater, the flag off: the look-in\'s one 404', bmNo.every(r => shape(r) === ref), bmNo.map(r => [r.status, r.wire]))
    check('signed out: 401', (await byMoment(lRow.public_id, {})).status === 401)

    // ── § 24 g someone's Moments ────────────────────────────────────────────
    section('§ 24 g someone\'s Moments: open rows, the filters on hidden people, the counts')
    const O = await bare('Olga Owner', pub), Vo = await mkUser('Vic Visitor'), Fr = await bare('Fritz Friend', pub), Fh = await bare('Hanni Hiddenfriend', settings('public-users', { show: false }))
    await setSettings(Vo.id, 'public-users')
    await mutual(Vo.id, Fr.id); await mutual(Vo.id, Fh.id)
    const Hx = await bare('Xaver Hiddenhost', settings('public-users', { show: false })), Hn = await bare('Nina Namedhost', pub)
    const ms = await rawMoment(O.id, { name: `${TAG} Shared`, hostName: 'Olga Owner', members: [{ id: Vo.id }] })
    const mo1 = await rawMoment(Hn.id, { visibility: 'verre', name: `${TAG} Open One`, hostName: 'Nina Namedhost', members: [{ id: O.id }] })
    const mo2 = await rawMoment(Hn.id, { visibility: 'verre', name: `${TAG} Only Inside`, hostName: 'Nina Namedhost', members: [{ id: O.id }] })
    await prisma.$executeRaw`INSERT INTO moment_privacy (session_id, user_id, only_inside) VALUES (${mo2.id}, ${O.id}, true)`
    const mo3 = await rawMoment(Hn.id, { visibility: 'members', name: `${TAG} Closed`, hostName: 'Nina Namedhost', members: [{ id: O.id }] })
    const mo4 = await rawMoment(Hx.id, { visibility: 'verre', name: null, hostName: 'Xaver Hiddenhost', members: [{ id: O.id }, { id: Fh.id }] })
    const mo5 = await rawMoment(Hn.id, { visibility: 'verre', name: `${TAG} With Friends`, hostName: 'Nina Namedhost', members: [{ id: O.id }, { id: Fr.id }, { id: Fh.id }] })
    await prisma.$executeRaw`UPDATE sessions SET show_place = true, address = 'Open Street 5', cover_photo_url = ${`https://s3.example.test/verre/sessions/${mo5.code}_9.png`} WHERE id = ${mo5.id}`
    await prisma.$executeRaw`UPDATE sessions SET address = 'Hidden Street 1' WHERE id = ${mo1.id}`
    // Not the shared one: the viewer is in it, and its row carries its code by design.
    for (const m of [mo1, mo2, mo3, mo4, mo5]) codes.add(m.code)
    const list = async (q = '') => {
      await resetLimits()
      const path = `/api/users/${O.pid}/moments${q ? `?${q}` : ''}`
      return seen(`list ${q}`, await call(momentsListRoute.GET, 'GET', path, Vo, undefined, { id: O.pid }))
    }
    const all = (await list()).wire
    const ids = (all.items as J[]).map(r => r.code ?? r.momentId)
    check('shared row (with its code) + the open rows where the owner is named to you; not the only-inside one, not the closed one',
      ids.length === 4 && ids.includes(ms.code) && [mo1.pid, mo4.pid, mo5.pid].every(p => ids.includes(p)) && !ids.includes(mo2.pid) && !ids.includes(mo3.pid), all.items)
    const open1 = (all.items as J[]).find(r => r.momentId === mo1.pid)!, open4 = (all.items as J[]).find(r => r.momentId === mo4.pid)!, open5 = (all.items as J[]).find(r => r.momentId === mo5.pid)!
    check('🔒 an open row: momentId, no code; no address without Show Place', !('code' in open1) && !('address' in open1) && PIDRE.test(open1.momentId), open1)
    check('…the address with Show Place; an old code-bearing cover dropped', open5.address === 'Open Street 5' && open5.coverPhotoUrl === null, open5)
    check('🔒 a nameless open moment whose host is hidden: no name (never the host\'s)', open4.name === null, open4)
    check('the shared row keeps today\'s shape (code, address)', (all.items as J[]).some(r => r.code === ms.code && 'address' in r))
    const header = async (viewer: Actor) => { await resetLimits(); return seen('header', await call(usersRoute.GET, 'GET', `/api/users/${O.pid}?view=header`, viewer, undefined, { id: O.pid })) }
    const hd = (await header(Vo)).wire
    check('shared + open + otherCount == the header\'s Moments count', all.items.length + all.otherCount === hd.tiles?.moments?.count && hd.tiles.moments.count === 6, { items: all.items.length, other: all.otherCount, header: hd.tiles?.moments })
    const idsOf = async (q: string) => ((await list(q)).wire.items as J[]).map(r => r.code ?? r.momentId).sort()
    check('people = a friend named there: their open moment matches', JSON.stringify(await idsOf(`people=u:${Fr.pid}`)) === JSON.stringify([mo5.pid]))
    check('🔒 people = a hidden friend: matches nothing (they are in two of the open moments)', (await idsOf(`people=u:${Fh.pid}`)).length === 0)
    check('hosts = u:<a named host>: matches', JSON.stringify(await idsOf(`hosts=u:${Hn.pid}`)) === JSON.stringify([mo1.pid, mo5.pid].sort()))
    check('🔒 hosts = u:<the hidden host> and n:<their name>: nothing', (await idsOf(`hosts=u:${Hx.pid}`)).length === 0 && (await idsOf(`hosts=${encodeURIComponent('n:Xaver Hiddenhost')}`)).length === 0)
    check('q on a named host\'s name matches', (await idsOf('q=Nina%20Namedhost')).includes(mo5.pid))
    check('🔒 q on the hidden host\'s name: nothing', (await idsOf('q=Xaver%20Hiddenhost')).length === 0)
    check('roles reads the owner\'s role on open rows', (await idsOf('roles=taster')).length === 3 && (await idsOf('roles=host')).join() === ms.code)
    const p1 = (await list('limit=2')).wire
    const p2 = (await list(`limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`)).wire
    const paged = [...p1.items, ...p2.items].map((r: J) => r.code ?? r.momentId)
    check('paging across shared and open rows: 2 + 2 in the same order, no repeat, no gap, no cursor after the last',
      p1.items.length === 2 && typeof p1.nextCursor === 'string' && p2.items.length === 2 && p2.nextCursor === null && JSON.stringify(paged) === JSON.stringify(ids), { paged, ids })
    // 101 moments the viewer may look into: only the 100 most recent are candidates.
    const O2 = await bare('Oona Many', pub)
    const made = await prisma.$queryRaw`
      INSERT INTO sessions (code, host_user_id, host_name, name, created_at, date_from, visibility)
      SELECT 'MC' || upper(substr(md5(random()::text || g::text), 1, 12)), ${Hn.id}, 'Nina Namedhost', ${`${TAG} many `} || g, now(), now() - (g || ' days')::interval, 'verre'
        FROM generate_series(1, 101) g
      RETURNING id, public_id, code, date_from` as J[]
    await prisma.sessionMember.createMany({ data: made.flatMap(m => [{ userId: Hn.id, sessionCode: m.code, role: 'host' }, { userId: O2.id, sessionCode: m.code }]) })
    for (const m of made) codes.add(m.code)
    const oldest = made.reduce((a, c) => (new Date(a.date_from) < new Date(c.date_from) ? a : c))
    const got: J[] = []
    let cur: string | null = null, other2: number | undefined
    do {
      await resetLimits()
      const path = `/api/users/${O2.pid}/moments?limit=50${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`
      const r = seen('list many', await call(momentsListRoute.GET, 'GET', path, Vo, undefined, { id: O2.pid })).wire
      if (cur === null) other2 = r.otherCount
      got.push(...r.items)
      cur = r.nextCursor
    } while (cur)
    check('only their 100 most recent moments you are not in can be open rows; the 101st is counted, never a row',
      got.length === 100 && got.every(r => PIDRE.test(r.momentId)) && !got.some(r => r.momentId === oldest.public_id) && other2 === 1, { rows: got.length, other2 })
    flag(false)
    const offList = (await list()).wire
    check('flag off: only the shared row; the rest counted', offList.items.length === 1 && offList.items[0].code === ms.code && offList.otherCount === 5, offList)
    flag(true)

    // ── § 24 h the tile ─────────────────────────────────────────────────────
    section('§ 24 h the Moments tile: the automatic cover for someone else only from a shared moment; the pin is kept')
    await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = 'https://s3.example.test/verre/covers/shared_1.png' WHERE id = ${ms.id}`
    await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = 'https://s3.example.test/verre/covers/open_1.png' WHERE id = ${mo1.id}`
    await prisma.$executeRaw`UPDATE session_members SET joined_at = now() - interval '2 days' WHERE session_code = ${ms.code} AND user_id = ${O.id}`
    await prisma.$executeRaw`UPDATE session_members SET joined_at = now() - interval '1 day' WHERE session_code = ${mo1.code} AND user_id = ${O.id}`
    const Wst = await mkUser('Wim Stranger')
    check('another viewer: the shared moment\'s cover, not the newer open one', (await header(Vo)).wire.tiles.moments.imageUrl === 'https://s3.example.test/verre/covers/shared_1.png')
    check('a viewer who shares none: no automatic cover', (await header(Wst)).wire.tiles.moments.imageUrl === null)
    flag(false)
    check('flag off: as before (the latest of all their moments)', (await header(Vo)).wire.tiles.moments.imageUrl === 'https://s3.example.test/verre/covers/open_1.png')
    flag(true)
    await prisma.user.update({ where: { id: O.id }, data: { tileMomentsUrl: 'https://s3.example.test/verre/covers/open_1.png' } })
    const pinned = (await header(Wst)).wire.tiles.moments.imageUrl
    check('🔒 a non-admitted viewer loading the profile leaves the owner\'s pin stored (and sees it: the owner\'s choice)',
      pinned === 'https://s3.example.test/verre/covers/open_1.png' && (await prisma.user.findUnique({ where: { id: O.id }, select: { tileMomentsUrl: true } })).tileMomentsUrl === 'https://s3.example.test/verre/covers/open_1.png')

    // ── § 24 i the feed and the web profile ─────────────────────────────────
    section('§ 24 i the feed and the web profile: momentId and hostName')
    const Hf = await mkUser('Hugo Feedhost'), Af = await mkUser('Ada Feedauthor'), Mf = await mkUser('Max Feedmember'), Of = await mkUser('Oda Feedoutsider')
    await setSettings(Hf.id, 'public-users', { show: false })
    for (const u of [Af, Mf, Of]) await setSettings(u.id, 'public-users')
    await setSettings(Af.id, 'public-internet')
    for (const u of [Mf, Of]) await follows(u.id, Af.id)
    const Fm = await createSession(Hf, 'Hugo Feedhost'); codes.add(Fm)
    const fmRow = await rowOf(Fm)
    await join(Fm, Af); await join(Fm, Mf)
    const fw = await addWine(Fm, Hf, `${TAG} Feed Bottle`)
    await rate(Fm, Af, fw.id, 4)
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'verre' WHERE id = ${fmRow.id}`
    const postId = Number((await prisma.$queryRaw`SELECT id FROM feed_items WHERE user_id = ${Af.id} AND session_id = ${fmRow.id}` as J[])[0].id)
    const feedPost = async (viewer: User, path: string) => {
      await resetLimits()
      const r = await call(feedRoute.GET, 'GET', path, viewer)
      if (viewer !== Mf) seen(`feed ${path}`, r)
      return ((r.wire?.items ?? []) as J[]).find(i => i.type === 'session' && i.session?.sessionId === fmRow.id)?.session as J | undefined
    }
    const paths = ['/api/feed', `/api/feed?user=${Af.pid}`, `/api/feed?user=${Af.pid}&item=${postId}`]
    const asMember = await Promise.all(paths.map(p => feedPost(Mf, p))), asOutsider = await Promise.all(paths.map(p => feedPost(Of, p)))
    check('a member: momentId and the host\'s name, on /api/feed, ?user= and ?item=', asMember.every(s => s?.momentId === fmRow.public_id && s.hostName === 'Hugo Feedhost'), asMember)
    check('🔒 an admitted outsider: momentId; the hidden host\'s name is null (all three paths)', asOutsider.every(s => s?.momentId === fmRow.public_id && s.hostName === null), asOutsider)
    await prisma.$executeRaw`UPDATE sessions SET visibility = 'members' WHERE id = ${fmRow.id}`
    const closed = await feedPost(Of, '/api/feed')
    check('🔒 an outsider not admitted: no momentId', !!closed && !('momentId' in closed) && closed.hostName === null, closed)
    await setSettings(Hf.id, 'public-users')
    check('…the host shown to them: the host\'s name (naming, not admission)', (await feedPost(Of, '/api/feed'))?.hostName === 'Hugo Feedhost')
    await setSettings(Hf.id, 'public-users', { show: false })
    flag(false)
    const offM = await feedPost(Mf, '/api/feed'), offO = await feedPost(Of, '/api/feed')
    check('🔒 flag OFF: no momentId for anyone, and the hostName rule still holds (live)', !!offM && !('momentId' in offM) && offM.hostName === 'Hugo Feedhost' && !!offO && !('momentId' in offO) && offO.hostName === null, [offM, offO])
    const webPost = async (viewerId: number | null) => {
      const gate = await resolveProfileViewer(Af.id, viewerId)
      if (gate.status !== 'ok') return undefined
      return (await loadProfile({ userId: Af.id, gate }))?.recentSessionPosts.find((p: J) => p.sessionId === fmRow.id) as J | undefined
    }
    const wm = await webPost(Mf.id), wo = await webPost(Of.id), wOut = await webPost(null)
    check('🔒 the web profile (flag off): the member sees the host\'s name; an outsider and a signed-out visitor do not', wm?.hostName === 'Hugo Feedhost' && wo?.hostName === null && wOut?.hostName === null, [wm?.hostName, wo?.hostName, wOut?.hostName])
    await setSettings(Hf.id, 'public-internet')
    check('…a host who shows to everyone: named to a signed-out visitor too', (await webPost(null))?.hostName === 'Hugo Feedhost')
    flag(true)

    // ── § 24 j the canary ───────────────────────────────────────────────────
    section('§ 24 j the canary: no code, no link token, no wine or rating id, no identity in what an outsider sees')
    const leakedCode = outside.filter(o => [...codes].some(c => o.text.includes(c)))
    check(`🔒 no response seen as a NON-member carries a fixture moment's code (${outside.length} responses, ${codes.size} codes)`, outside.length > 40 && leakedCode.length === 0, leakedCode.map(o => o.where))
    const leakedTok = outside.filter(o => [...tokens].some(t => t && o.text.includes(t)))
    check(`🔒 …nor a link token (${tokens.size} tokens)`, tokens.size >= 3 && leakedTok.length === 0, leakedTok.map(o => o.where))
    const tokenInRedis: string[] = []
    for (const c of codes) for (const key of await h.scanKeys(`s:${c}:*`)) {
      const t = await redis.type(key)
      const vals = t === 'string' ? [await redis.get(key)] : t === 'hash' ? Object.entries(await redis.hGetAll(key)).flat() : t === 'set' ? await redis.sMembers(key) : []
      if (vals.some(v => [...tokens].some(tk => tk && String(v).includes(tk)))) tokenInRedis.push(key)
    }
    check('🔒 …and no s:{CODE}:* value holds a token', tokenInRedis.length === 0, tokenInRedis)
    const ALLOWED = new Set(['member', 'moment', 'id', 'name', 'coverPhotoUrl', 'category', 'dateFrom', 'dateTo', 'blind', 'timezone', 'address', 'description', 'link', 'host', 'imageUrl',
      'lineupHidden', 'lineup', 'position', 'producer', 'vintage', 'grape', 'colour', 'sparkling', 'abv', 'region', 'country', 'vinification', 'purchaseUrl', 'broughtBy', 'avg', 'count',
      'people', 'total', 'named', 'more', 'key', 'guest', 'ratings', 'person', 'score', 'notes', 'flavors', 'aromas'])
    const badKeys = new Set<string>(), badIds: unknown[] = []
    const walk = (v: unknown, key?: string): void => {
      if (key === 'flavors') { if (!v || typeof v !== 'object' || Object.values(v).some(x => typeof x !== 'number')) badKeys.add('flavors (a non-number)'); return }
      if (key === 'aromas') { for (const a of v as J[]) for (const kk of Object.keys(a)) if (!['a', 'm', 'p'].includes(kk)) badKeys.add(`aromas.${kk}`); return }
      if (Array.isArray(v)) { v.forEach(x => walk(x)); return }
      if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) { if (!ALLOWED.has(kk)) badKeys.add(kk); if (kk === 'id' && !PIDRE.test(String(x))) badIds.push(x); walk(x, kk) }
    }
    lookBodies.forEach(x => walk(x))
    check(`🔒 every look-in body (${lookBodies.length}) is the allow-list: no other key, every id a public id`, lookBodies.length >= 15 && badKeys.size === 0 && badIds.length === 0, { keys: [...badKeys], ids: badIds.slice(0, 5) })
    // A rating id could only travel as a number under a key, and the walk
    // above allows none that could carry one (no `ratingId`, every `id` a
    // public id); the fixture's ratings exist, so the check is not vacuous.
    const noUrls = lookBodies.map(x => JSON.stringify(x).replace(/https?:\/\/[^"]+/g, ''))
    const allWineIds = [...wineIds, fw.id]
    check('🔒 …no wine id outside photo URLs, no a: / u: / d: identity (the fixture has wine ids, guests, a tombstone and ratings)',
      ratingIds.length >= 8 && noUrls.every(t => !allWineIds.some(w => t.includes(w)) && !/"[aud]:[0-9A-Za-z]/.test(t) && !/[aud]:[0-9a-f]{8}-/.test(t) && !t.includes(tomb)),
      noUrls.find(t => allWineIds.some(w => t.includes(w)) || /[aud]:/.test(t))?.slice(0, 300))
  } finally {
    if (saved.flag === undefined) delete process.env.MOMENT_LOOKIN_ENABLED; else process.env.MOMENT_LOOKIN_ENABLED = saved.flag
    if (saved.secret === undefined) delete process.env.MOMENT_LINK_SECRET; else process.env.MOMENT_LINK_SECRET = saved.secret
  }
}
