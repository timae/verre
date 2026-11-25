#!/usr/bin/env node
// CI census: every write of a `session_members` row on the server (app/, lib/)
// (Moment Defaults, docs/dev/proposals/moment-defaults.md; K1 / K2 of the
// build plan). The rule: a person's defaults (Incognito, Hide from Feed for
// their post) are COPIED when their participation in a moment STARTS, and
// participation starts at a membership write. Every such write is classified:
//  - ENTRY: participation may start here, so the same function calls
//    `seedParticipation` (lib/momentDefaults.ts) after the insert;
//  - NOT ENTRY: it never starts participation (the reason is pinned), so it
//    must NOT seed.
// A new write fails the build until it is classified here: a writer that
// starts participation without seeding would silently skip a protective
// default; one that seeds where participation is old would copy today's
// default onto an existing post (the retroactivity the feature forbids).
//
// Patterns: raw `INSERT INTO session_members`, and Prisma
// `.sessionMember.create / createMany / upsert`. "The same function" = from
// the write to the next line that closes a top-level block (a `}` in column
// 0). Comments are excluded.
//
// ⚠️ BLIND SPOTS (a text census): SQL assembled in another file, a delegate
// held in a variable, an UPDATE that re-admits a kicked row (the one that
// matters, `/join`'s clearKick, is inside ensureMemberRow, an ENTRY), and
// test / script files (outside app/ and lib/).
//
// Run: node scripts/check-member-writes.mjs   (exits 1 on any difference)
//      node scripts/check-member-writes.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// file → [pinned count, 'ENTRY' | 'NOT ENTRY', why]
const EXPECTED = {
  'app/api/session/route.ts': [1, 'ENTRY', 'the signed-in create: the host\'s own member row; their Incognito / Hide from Feed (the body\'s, else their defaults)'],
  'lib/sessionMember.ts': [1, 'ENTRY', 'ensureMemberRow (/visit, signed-in /join, /rate): seeds on an insert or a cleared kick, never the strict host, never a rating author (K1)'],
  'lib/session.ts': [1, 'ENTRY', 'promotion: every NON-kicked inserted person, each their own defaults, in one statement'],
  'app/api/session/[code]/route.ts': [1, 'NOT ENTRY', 'set-role: the target must already take part (an identities entry, a member or a rating author)'],
  'lib/sessionWipe.ts': [1, 'NOT ENTRY', 'kick-keep: a KICKED row for any account (a pre-emptive placeholder); it seeds on re-admission, /join\'s clearKick'],
}

const CODE_FILE = /\.(ts|tsx|mts|mjs|js)$/
const inScope = (f) => CODE_FILE.test(f) && (f.startsWith('app/') || f.startsWith('lib/'))

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  .replace(/(^|\s)--(?=\s|$)[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

// Across line breaks (`\s` matches a newline: Codex build r1, an INSERT split
// over two lines must not slip past).
const WRITE = /\bINSERT\s+INTO\s+session_members\b|\.\s*sessionMember\s*\.\s*(?:create|createMany|upsert)\s*\(/gi
const SEED = /\bseedParticipation\s*\(/

// Each write (the line it starts on) with whether a seed follows it in the
// same top-level block (up to the next line that starts with `}`).
export function memberWrites(source) {
  const src = stripComments(source)
  const out = []
  for (const m of src.matchAll(WRITE)) {
    const line = src.slice(0, m.index).split('\n').length
    const rest = src.slice(m.index)
    const end = rest.search(/\n\}/)
    out.push({ line, seeded: SEED.test(end === -1 ? rest : rest.slice(0, end)) })
  }
  return out
}

function selfTest() {
  const writes = [
    ['raw insert', "await tx.$executeRaw`INSERT INTO session_members (user_id, session_code) VALUES (${u}, ${c})`"],
    ['raw insert, lower case', "sql`insert into session_members (user_id) values (1)`"],
    ['prisma create', "await prisma.sessionMember.create({ data: { userId, sessionCode } })"],
    ['prisma createMany', "await tx.sessionMember.createMany({ data })"],
    ['prisma upsert', "await tx.sessionMember.upsert({ where, create, update })"],
    ['raw insert over two lines', "await tx.$executeRaw`\n  INSERT INTO\n    session_members (user_id) VALUES (1)`"],
    ['prisma create over two lines', "await tx.sessionMember\n  .create({ data })"],
  ]
  const notWrites = [
    ['a line comment', "// INSERT INTO session_members happens in the create"],
    ['a block comment', "/* INSERT INTO session_members */"],
    ['an SQL comment', "  -- INSERT INTO session_members below"],
    ['a read', "SELECT role FROM session_members WHERE user_id = 1"],
    ['a delete', "DELETE FROM session_members WHERE session_code = ${c}"],
    ['a find', "await prisma.sessionMember.findMany({ where: { userId } })"],
  ]
  const span = [
    ['seed in the same function', 'async function a(tx) {\n  await tx.$executeRaw`INSERT INTO session_members (user_id) VALUES (1)`\n  await seedParticipation(tx, row, [1])\n}\n', true],
    ['seed only in the next function', 'async function a(tx) {\n  await tx.$executeRaw`INSERT INTO session_members (user_id) VALUES (1)`\n}\nasync function b(tx) {\n  await seedParticipation(tx, row, [1])\n}\n', false],
    ['no seed at all', 'export async function a(tx) {\n  await tx.sessionMember.create({ data })\n}\n', false],
  ]
  const bad = [
    ...writes.filter(([, src]) => memberWrites(src).length !== 1).map(([n]) => `missed a write: ${n}`),
    ...notWrites.filter(([, src]) => memberWrites(src).length !== 0).map(([n]) => `flagged a non-write: ${n}`),
    ...span.filter(([, src, want]) => memberWrites(src)[0]?.seeded !== want).map(([n]) => `wrong seed span: ${n}`),
  ]
  if (bad.length) { console.error('check-member-writes: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return writes.length + notWrites.length + span.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-member-writes: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope)
if (files.length === 0) { console.error('check-member-writes: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = memberWrites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}
const problems = []
for (const [file, sites] of Object.entries(found)) {
  const pin = EXPECTED[file]
  if (!pin) { problems.push(`${file}: ${sites.length} session_members write(s) in a file not on the list`, ...sites.map((s) => `    ${file}:${s.line}`)); continue }
  const [n, kind, why] = pin
  if (sites.length !== n) problems.push(`${file}: ${sites.length} session_members write(s), pinned at ${n} (${kind}: ${why})`, ...sites.map((s) => `    ${file}:${s.line}`))
  for (const s of sites) {
    if (kind === 'ENTRY' && !s.seeded) problems.push(`${file}:${s.line}: an ENTRY write with no seedParticipation after it in the same function (${why})`)
    if (kind === 'NOT ENTRY' && s.seeded) problems.push(`${file}:${s.line}: a NOT ENTRY write followed by seedParticipation (${why})`)
  }
}
for (const [file, [n]] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`${file}: pinned at ${n} but has no session_members writes now: lower the pin (or remove the entry)`)
}
if (problems.length === 0) {
  const total = Object.values(found).reduce((a, s) => a + s.length, 0)
  console.log(`check-member-writes: OK — ${total} session_members writes in ${Object.keys(found).length} listed files (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-member-writes: FAILED: a session_members write changed.')
console.error('Participation starts at a membership write, and Moment Defaults are copied exactly then')
console.error('(lib/momentDefaults.ts seedParticipation; lib/CLAUDE.md § Moment Defaults). Classify the write')
console.error('as ENTRY (seed after it) or NOT ENTRY (with the reason) in scripts/check-member-writes.mjs.\n')
for (const p of problems) console.error(`  ${p}`)
process.exit(1)
