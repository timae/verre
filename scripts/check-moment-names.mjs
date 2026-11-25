#!/usr/bin/env node
// CI census: every READ (and write) of a moment's NAME on the server: app/,
// lib/, the root .ts files, and every components/ file that imports
// lib/prisma (a server component; client components only render payloads)
// (Moment Visibility step 3b, T9). The rule (R16, root CLAUDE.md § Profile
// visibility): a moment's name, outside the moment, is shown only to a viewer
// who could open it (your own posts and rows; people in it, `insiderSql` /
// `decideMoments`' member; the audience, `decideMoments` / `decideAdmission`'s
// open, lib/momentAudience.ts); everyone else gets `privateMoment`. A new read
// path that skips it shows the name to the wrong people.
//
// It pins the SOURCE, not wire keys: names leave under many keys
// (`sessionName`, `momentName`, `lastMoment.name`, a row's `name`). Every line
// matching one of these sits in a file on the list below with a pinned count
// and its reason, so a new read (or one more in a listed file) fails the build
// until it is reviewed:
//  - raw SQL:  `s.name`, `sessions.name`, a bare `host_name`
//  - Prisma:   `hostName: true`; `<client>.session.find*` / `.update*` (a find
//              without a select returns every column, the name included)
//  - relation: `session` / `sourceSession` / `hostedSessions` (every relation
//              to Session in the schema): `: true`, or `: { select: { … name: true` (one line)
// Reasons: INSIDE (the moment's own views and its record), OWN (the caller's
// own moments), OUTSIDE through the rule, WRITE, NOT A NAME (a session row
// read for another column), NOT A SESSION (an `s` that is something else).
//
// ⚠️ BLIND SPOTS (a text census, not a type system): an unaliased `name` beside
// no `host_name`, another alias of `sessions` (none read a name today: the
// build checked every `FROM|JOIN sessions <alias>`), a multi-line Prisma
// select without `hostName`, a delegate held in a variable, SQL assembled in
// another file, a client component, and the Redis meta (`s:{CODE}:meta` carries
// the name; it is read outside a moment's own routes, e.g. app/api/me/sessions,
// lib/momentLookIn.ts, lib/accountDelete.ts (not an exhaustive list): none of
// those returns the name to a caller today, and a new one would go unseen). It pins
// COUNTS: swapping a gated read for an ungated one in a listed file keeps the
// count. Comments are excluded (`//`, `/* */`, and SQL `--` lines).
//
// Run: node scripts/check-moment-names.mjs   (exits 1 on any difference)
//      node scripts/check-moment-names.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// file → [pinned count, why each may read the name]
const EXPECTED = {
  'app/api/feed/route.ts': [1, 'OUTSIDE through the rule: the page\'s session select; the name only on your own post or to member || open (decideMoments, R16), else privateMoment with no host and no sessionId (T5)'],
  'lib/profileLoad.ts': [1, 'OUTSIDE through the rule: the web profile\'s session posts, the feed\'s rule (signed out: every moment private)'],
  'lib/profileLists.ts': [6, 'OUTSIDE through the rule: someone\'s Impressions (insider || decideAdmission open, else privateMoment; `q`\'s moment half by the same rule, § 2.3), your own Cravings (only a moment you were there in, T6), someone\'s Moments (shared rows: you are in it; open rows: decideMoments, the host name only where hostNamed)'],
  'lib/momentFacets.ts': [5, 'OUTSIDE through the rule: someone\'s Moments filters, over shared rows and open rows only (the host name only where hostNamed)'],
  'lib/momentLookIn.ts': [3, 'OUTSIDE through the rule: the look-in body, only to a member or a viewer the audience admits (decideMoments)'],
  'lib/sessionRecord.ts': [1, 'INSIDE: the record read that rebuilds the moment\'s own meta (the live views)'],
  'app/api/session/[code]/preview/route.ts': [1, 'INSIDE: the pre-join preview to a code holder (who can join); this line reads the public id only'],
  'app/api/me/sessions/route.ts': [6, 'OWN: the caller\'s own moments (sm.user_id = me)'],
  'lib/peopleSql.ts': [1, 'OWN: tasted-with\'s last moment, the caller\'s own non-kicked memberships'],
  'app/api/session/[code]/route.ts': [1, 'WRITE: the soft-delete scrub (host_name = NULL)'],
  'app/api/session/[code]/settings/route.ts': [1, 'WRITE: the settings columns, inside the contract (host)'],
  'lib/accountDelete.ts': [2, 'WRITE: the host tombstone and the deleted moment\'s scrub'],
  'lib/displayName.server.ts': [2, 'WRITE: the host_name mirror on a profile rename (the update and its log line)'],
  'app/api/checkins/[id]/route.ts': [1, 'NOT A NAME: a session-rating check-in\'s own moment, select { code }'],
  'app/api/session/[code]/me/privacy/route.ts': [1, 'NOT A NAME: the live row\'s id, select { id }'],
  'app/api/session/[code]/wines/route.ts': [1, 'NOT A NAME: the live row\'s id, select { id }'],
  'lib/session.ts': [2, 'NOT A NAME: the live row\'s id (and lineupRevision), select only those'],
  'lib/occurrences.ts': [2, 'NOT A SESSION: a bottle snapshot\'s `s.name` (s = the snapshot)'],
}

const CODE_FILE = /\.(ts|tsx|mts|mjs|js)$/
const inScope = (f) => CODE_FILE.test(f) && (f.startsWith('app/') || f.startsWith('lib/') || !f.includes('/')
  || (f.startsWith('components/') && existsSync(f) && /['"]@\/lib\/prisma['"]|lib\/prisma(\.ts)?['"]/.test(readFileSync(f, 'utf8'))))

// Comments out, line structure kept: block comments, `//` line comments (not
// inside a URL), and SQL `--` comments (whitespace or line start before them,
// so `i--` stays).
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  .replace(/(^|\s)--(?=\s|$)[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const PATTERNS = [
  ['SQL s.name', /\bs\.name\b/],
  ['SQL sessions.name', /\bsessions\.name\b/],
  ['SQL host_name', /\bhost_name\b/],
  ['Prisma hostName: true', /\bhostName\s*:\s*true\b/],
  ['Prisma session find/update', /\.\s*session\s*\.\s*(?:find\w*|update\w*)\s*\(/],
  ['relation to Session: true', /\b(?:session|sourceSession|hostedSessions)\s*:\s*true\b/],
  ['relation to Session name', /\b(?:session|sourceSession|hostedSessions)\s*:\s*\{\s*select\s*:\s*\{[^}\n]*\bname\s*:\s*true\b/],
]

export function nameSites(source) {
  const sites = []
  stripComments(source).split('\n').forEach((line, i) => {
    const hit = PATTERNS.find(([, re]) => re.test(line))
    if (hit) sites.push({ line: i + 1, kind: hit[0] })
  })
  return sites
}

// The negative control: each read idiom caught, each non-read passed.
function selfTest() {
  const must = [
    ['raw s.name', "prisma.$queryRaw`SELECT s.id, s.name FROM sessions s WHERE s.id = ${id}`"],
    ['raw sessions.name', "sql`SELECT sessions.name FROM sessions`"],
    ['raw host_name', "sql`SELECT host_name AS \"hostName\" FROM sessions`"],
    ['prisma hostName', "select: { id: true, name: true, hostName: true },"],
    ['prisma find', "await prisma.session.findFirst({ where: { code } })"],
    ['tx find', "await tx.session.findUnique({ where: { id } })"],
    ['prisma update', "await prisma.session.updateMany({ where: { hostUserId }, data: { hostName } })"],
    ['relation true', "prisma.feedItem.findMany({ include: { session: true } })"],
    ['relation name', "prisma.rating.findMany({ select: { session: { select: { id: true, name: true } } } })"],
    ['a craving\'s moment', "prisma.bookmark.findMany({ include: { sourceSession: true } })"],
    ['a host\'s moments', "prisma.user.findUnique({ select: { hostedSessions: { select: { id: true, name: true } } } })"],
  ]
  const mustNot = [
    ['a line comment', "// SELECT s.name FROM sessions s"],
    ['a block comment', "/* s.host_name is the host's display name */"],
    ['an SQL comment', "  -- reads s.name, as your own list does (r.name || r.host_name)"],
    ['a decrement', "for (let i = n; i--; ) total += s.score"],
    ['a wine name', "sql`SELECT w.name FROM wines w`"],
    ['a wire key', "sessionName: deleted ? null : (s?.name ?? null), momentName: r.moment_name"],
    ['a host wire key', "hostName: d && d.hostNamed ? s.hostName : null"],
    ['hostNamed', "const hostNamed = open.filter(d => d.hostNamed)"],
    ['another model', "await prisma.sessionMember.findMany({ where: { userId } })"],
    ['the auth session', "const id = session.user.id; if (!session?.user) return"],
    ['a relation id only', "prisma.bookmark.findMany({ select: { sourceSession: { select: { id: true } } } })"],
  ]
  const bad = [
    ...must.filter(([, src]) => nameSites(src).length === 0).map(([n]) => `missed a read: ${n}`),
    ...mustNot.filter(([, src]) => nameSites(src).length > 0).map(([n]) => `flagged a non-read: ${n}`),
  ]
  if (bad.length) { console.error('check-moment-names: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return must.length + mustNot.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-moment-names: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope)
if (files.length === 0) { console.error('check-moment-names: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = nameSites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}
const problems = []
for (const [file, sites] of Object.entries(found)) {
  const pin = EXPECTED[file]
  if (!pin) problems.push(`${file}: ${sites.length} moment-name read(s) in a file not on the list`, ...sites.map((s) => `    ${file}:${s.line}  ${s.kind}`))
  else if (sites.length !== pin[0]) problems.push(`${file}: ${sites.length} moment-name read(s), pinned at ${pin[0]} (${pin[1]})`, ...sites.map((s) => `    ${file}:${s.line}  ${s.kind}`))
}
for (const [file, [n]] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`${file}: pinned at ${n} but has no moment-name reads now: lower the pin (or remove the entry)`)
}
if (problems.length === 0) {
  const total = Object.values(found).reduce((a, s) => a + s.length, 0)
  console.log(`check-moment-names: OK — ${total} moment-name reads in ${Object.keys(found).length} listed files (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-moment-names: FAILED: a read of a moment\'s name changed.')
console.error('A moment\'s name outside it goes only to a viewer who could open it (lib/momentAudience.ts;')
console.error('root CLAUDE.md § Profile visibility). If the new read is inside the moment, your own, or')
console.error('through the rule, update its pin in scripts/check-moment-names.mjs with its reason.\n')
for (const p of problems) console.error(`  ${p}`)
process.exit(1)
