#!/usr/bin/env node
// CI census: lib/username.ts is the ONLY app code that writes users.username,
// besides the web register's insert (docs/dev/proposals/usernames.md § 8).
// Better Auth's own sign-up insert is not our code (the `input: true` field in
// lib/betterAuth.ts) and is pinned by scripts/check-better-auth-config.mjs
// (/update-user stays disabled) plus the user.update.before hook.
//
// Why a chokepoint: the quota, the conflict answers (a HELD name fails like a
// taken one, through a trigger) and the READ COMMITTED rule live in one
// place. A username written from a profile PATCH would skip the quota; one
// written by a raw UPDATE would surface a taken name as P2010 instead of P2002.
//
// A CENSUS, not a deny-list: every site the matchers find is compared with
// the expected list below, so a new writer fails the build until it is
// reviewed and added (or moved into lib/username.ts).
//
// What counts as a write (reads never match: where / select / wire objects):
//  1. A Prisma WRITE call on the user model (`user.create|createMany|update|
//     updateMany|upsert(`) whose argument text mentions `username`.
//  2. Raw SQL: `UPDATE users … SET … username =` or an `INSERT INTO users (…
//     username …)`.
//  3. An assignment to a `.username` / `['username']` property
//     (`data.username = …`): a `data` object built in steps.
//     (`session.user.username = …` in auth.ts is an expected site: it fills
//     the session object, not the table.)
//  4. A user write whose `data` the matcher can't read (an identifier, the
//     `{ where, data }` shorthand, or a spread inside the call) in a file
//     that has `username` as an object KEY anywhere (`{ name, username }`,
//     `username: x`): the ordinary `const data = { name, username };
//     prisma.user.update({ where, data })`. Coarse on purpose: a user write
//     with opaque data next to a username key gets a human's eyes.
//  5. Better Auth's adapter: `updateUser(…)` / `createUser(…)` with `username`
//     in the argument text.
//
// KNOWN LIMITS (a text census, not a type system): an aliased delegate
// (`const u = prisma.user; u.update(…)`), a computed key, a `data` object
// built in ANOTHER file, a nested relation write from another model
// (`follow.update({ data: { follower: { update: { username } } } })`),
// `Object.assign(data, { username })` in a file with no user write of its
// own. The database still enforces uniqueness and holds for all of them; what
// such a writer would skip is the quota. The `ProfileFields` type
// (lib/profileImage.ts) has no `username`, so the profile PATCH cannot carry
// one through its helper.
//
// Run: node scripts/check-username-writes.mjs   (exits 1 on any difference)
//      node scripts/check-username-writes.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ALLOWED = 'lib/username.ts'
// file → the number of write sites expected there.
const EXPECTED = {
  // The sign-up insert: the username rides the same statement as the user row.
  'app/api/auth/register/route.ts': 1,
  // session.user.username = dbUser.username (the session object, not a table).
  'auth.ts': 1,
  // user.username = row?.username on the native auth RESPONSE body (the fresh
  // read; a wire object, not a table).
  'app/api/auth/native/[...all]/route.ts': 1,
  // The account PATCH's `data: updates` (opaque to the matcher) beside the
  // GET's `username` key. Reviewed: `updates` is typed `{ name?, email? }`.
  'app/api/me/account/route.ts': 1,
}

const inScope = (f) =>
  f === 'auth.ts' || f === 'auth.config.ts' || f === 'proxy.ts' ||
  ((f.startsWith('app/') || f.startsWith('lib/') || f.startsWith('components/')) && (f.endsWith('.ts') || f.endsWith('.tsx')))

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

// The argument text of a call starting at the `(` at `open`.
function callText(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

const WRITE_CALL = /\buser\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/g
// `"?username"?\s*=` or the row form `SET (name, username) = (…)`.
const RAW_UPDATE = /\bUPDATE\s+(?:public\s*\.\s*)?"?users"?\b[^;`]*?\bSET\b[^;`]*?(?:"?\busername\b"?\s*=|\([^)]*\busername\b[^)]*\)\s*=)/gi
const RAW_INSERT = /\bINSERT\s+INTO\s+(?:public\s*\.\s*)?"?users"?\s*\([^)]*\busername\b/gi
const ASSIGN = /(?:\.username|\[\s*['"]username['"]\s*\])\s*=(?!=)/g
const ADAPTER_CALL = /\b(?:updateUser|createUser)\s*\(/g
// `data` the matcher can't see into: `data: ident`, the `data` shorthand, a spread.
const OPAQUE_DATA = /\bdata\s*:\s*[A-Za-z_$][\w$.]*\s*[,})]|[{,]\s*data\s*[,}]|\.\.\./
// `username` as an object key: `username:` (not a `?:` type member) or shorthand.
const USERNAME_KEY = /[{,]\s*username\s*(?::|,|})/

export function writeSites(source) {
  const src = stripComments(source)
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const sites = []
  const keyInFile = USERNAME_KEY.test(src)
  for (const m of src.matchAll(WRITE_CALL)) {
    const call = callText(src, m.index + m[0].length - 1)
    if (/\busername\b/.test(call)) sites.push({ line: lineOf(m.index), kind: 'model write' })
    else if (keyInFile && OPAQUE_DATA.test(call)) sites.push({ line: lineOf(m.index), kind: 'model write with opaque data in a file that has a username key' })
  }
  for (const m of src.matchAll(ADAPTER_CALL)) {
    if (/\busername\b/.test(callText(src, m.index + m[0].length - 1))) sites.push({ line: lineOf(m.index), kind: 'Better Auth adapter write' })
  }
  for (const re of [RAW_UPDATE, RAW_INSERT]) for (const m of src.matchAll(re)) sites.push({ line: lineOf(m.index), kind: 'raw SQL' })
  for (const m of src.matchAll(ASSIGN)) sites.push({ line: lineOf(m.index), kind: 'assignment' })
  return sites
}

// The negative control: the matchers must catch each write idiom and pass
// each read idiom, or the census is green for the wrong reason.
function selfTest() {
  const must = [
    ['model update', "await prisma.user.update({ where: { id }, data: { username: name } })"],
    ['multi-line tx create', "await tx.user.create({\n  data: { name, email,\n    username },\n})"],
    ['upsert', "prisma.user.upsert({ where: { id }, create: { username }, update: {} })"],
    ['updateMany', "prisma.user.updateMany({ where: {}, data: { username: null } })"],
    ['raw update', "await prisma.$executeRaw`UPDATE users SET name = ${n}, username = ${u} WHERE id = ${id}`"],
    ['raw quoted update', 'await tx.$executeRaw`UPDATE "users"\n SET username = ${u}`'],
    ['raw insert', "prisma.$executeRaw`INSERT INTO users (name, email, username) VALUES (${a}, ${b}, ${c})`"],
    ['built data object', "const data = {}\ndata.username = name\nawait writeProfileFields(id, data)"],
    ['bracket assignment', "data['username'] = name"],
    ['data object by name', "const data = { name, username }\nawait prisma.user.update({ where: { id }, data })"],
    ['data object by key', "const patch = { username: name }\nawait prisma.user.update({ where: { id }, data: patch })"],
    ['spread data', "const patch = { name, username }\nawait tx.user.update({ where: { id }, data: { ...patch } })"],
    ['schema-qualified raw update', "prisma.$executeRaw`UPDATE public.users SET username = ${u} WHERE id = ${id}`"],
    ['row-form raw update', "prisma.$executeRaw`UPDATE users SET (name, username) = (${n}, ${u}) WHERE id = ${id}`"],
    ['Better Auth adapter', "await ctx.internalAdapter.updateUser(String(id), { username: name })"],
  ]
  const mustNot = [
    ['select', "prisma.user.findUnique({ where: { id }, select: { username: true } })"],
    ['lookup', "prisma.user.findUnique({ where: { username: name }, select: { id: true } })"],
    ['wire object', "return { id: r.public_id, name: r.name, username: r.username }"],
    ['raw read', "prisma.$queryRaw`SELECT u.username FROM users u WHERE u.username LIKE ${q}`"],
    ['comparison', "if (before.username === checked.username) return"],
    ['another column', "await prisma.user.update({ where: { id }, data: { name } })"],
    ['a comment', "// prisma.user.update({ data: { username } }) would skip the quota"],
    ['holds table', "prisma.$executeRaw`DELETE FROM username_holds WHERE held_until <= now()`"],
    ['opaque data, no username key in the file', "const data = { name, bio }\nawait prisma.user.update({ where: { id }, data })"],
    ['a typed field is not a key', "type U = { name: string; username?: string | null }\nawait prisma.user.update({ where: { id }, data: updates })"],
    ['adapter call without it', "await internalAdapter.updateUser(String(id), { name })"],
  ]
  const bad = [
    ...must.filter(([, src]) => writeSites(src).length === 0).map(([n]) => `missed a write: ${n}`),
    ...mustNot.filter(([, src]) => writeSites(src).length > 0).map(([n]) => `flagged a read: ${n}`),
  ]
  if (bad.length) { console.error('check-username-writes: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return must.length + mustNot.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-username-writes: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope).filter((f) => f !== ALLOWED)
if (files.length === 0) { console.error('check-username-writes: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = writeSites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}

const problems = []
for (const [file, sites] of Object.entries(found)) {
  const want = EXPECTED[file] ?? 0
  if (sites.length !== want) problems.push(...sites.map((s) => `  ${file}:${s.line}  ${s.kind} (expected ${want} site(s) in this file, found ${sites.length})`))
}
for (const [file, want] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`  ${file}  expected ${want} site(s), found none: update EXPECTED if the writer moved`)
}

if (problems.length === 0) {
  console.log(`check-username-writes: OK — users.username is written only in ${ALLOWED} and the ${Object.keys(EXPECTED).length} expected site(s) (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-username-writes: FAILED — users.username writes go through lib/username.ts (changeUsername).')
console.error('A new writer needs the quota, the conflict answers and READ COMMITTED: docs/dev/proposals/usernames.md § 8.\n')
for (const p of problems) console.error(p)
process.exit(1)
