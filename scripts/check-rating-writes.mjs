#!/usr/bin/env node
// CI census: every write of a session rating on the server (app/, lib/), and
// every place that spells or writes a rating KEY, classified against the
// version check (docs/dev/rating-saves.md § The writers; tasting feedback
// 2026-11-25). The rule: EVERY write of a signed-in session rating of a
// Postgres-backed moment bumps `rating_versions` in the SAME transaction
// (lib/ratingVersions.ts), so a save based on an older version is refused. A
// writer that forgets it lets a stalled or waited phone save overwrite a newer
// rating (or resurrect a cleared one, with its XP).
//
// Each site carries a tag on its line or within the 3 lines above it, in a
// comment (`// rating-write: BUMPS`, or `-- rating-write: …` inside SQL), and
// each file's counts per kind are pinned below with the reason:
//  - BUMPS: the enclosing top-level function calls a bump helper
//    (bumpRatingVersion / bumpRaterVersions /
//    bumpBottleVersions), checked here;
//  - COPIES: the enclosing function copies the version rows
//    (copyRatingVersions), checked here;
//  - EXEMPT: no version (a guest, a standalone rating, account deletion, the
//    rebuild from the record, a read); the reason is pinned.
// A new site fails the build until it is tagged AND pinned; a tag without a
// site fails too.
//
// Sites: SQL `INSERT INTO ratings` / `UPDATE ratings` / `DELETE FROM ratings`,
// `DELETE FROM wines` (its ratings cascade), the table name quoted or
// schema-qualified too; Prisma `.rating.create / update / upsert / delete…`
// (the `…AndReturn` forms included) and `.wine.delete…`, and NESTED writes
// through a relation (`rating: { update: … }`, `ratings: { deleteMany: … }`);
// calls of `engagementCascadeIn`; rating keys: `ratingKeyWrite(`,
// `copyRatingKeys(`, `dropKeys.push(`, `k.rating(` and any template that spells
// `s:${…}:r:`. Comments are excluded.
//
// ⚠️ BLIND SPOTS (a text census): SQL assembled in another file, a delegate
// held in a variable, a cascade from a table other than `wines`, and test /
// script files (outside app/ and lib/). And the BUMPS / COPIES check is per
// top-level FUNCTION, not per branch: a function that bumps on one path passes
// a site on another path that doesn't (rating-saves-integration.mts drives
// each writer's paths and reads the version).
//
// Run: node scripts/check-rating-writes.mjs   (exits 1 on any difference)
//      node scripts/check-rating-writes.mjs --self-test
//      node scripts/check-rating-writes.mjs --list   (every site with its tag)

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// file → { BUMPS?: [count, why], COPIES?: [count, why], EXEMPT?: [count, why] }
const EXPECTED = {
  'app/api/session/[code]/rate/route.ts': {
    BUMPS: [5, 'the rate POST: the upsert, the action-XP column, the Clear\'s reap and its key DEL, the key SET; one bumpRatingVersion per committed write'],
    EXEMPT: [2, 'a GUEST\'s Redis-only save (no version: a signed-in save without a record answers 503), and the key spelled for both'],
  },
  'app/api/session/[code]/rate/[wineId]/route.ts': {
    BUMPS: [3, 'the web Reset: the forced cascade and the key DEL (a guest\'s key DEL shares the statement; guests have no version; a Reset with no row in this moment is version-neutral)'],
  },
  'app/api/checkins/[id]/route.ts': {
    BUMPS: [5, 'the post edit of a moment rating (patchSessionRating): the UPDATE, the emptied rating\'s cascade, the key mirror (SET / DEL)'],
    EXEMPT: [2, 'standalone check-ins (the PATCH\'s rating update, the DELETE): no moment, no version'],
  },
  'app/api/checkins/route.ts': {
    EXEMPT: [1, 'the check-in POST: a standalone rating, no version'],
  },
  'app/api/session/[code]/wines/[wineId]/route.ts': {
    BUMPS: [3, 'the host\'s bottle DELETE: every version row of the bottle moves before its ratings cascade; its rating keys dropped after COMMIT'],
  },
  'lib/sessionWipe.ts': {
    BUMPS: [2, 'kick / ban with delete, a full leave: the rater\'s versions move before their ratings go; the keys after COMMIT'],
    EXEMPT: [1, 'a d: tombstone group\'s ratings (a deleted account: no user, no version)'],
  },
  'lib/occurrences.ts': {
    COPIES: [3, 'the bottle re-mint (copyCachedLineup): the moved raters\' version rows copied with their ratings and keys'],
    EXEMPT: [1, 'copyRatingKeys, the key-copy primitive; its caller (copyCachedLineup) copies the versions'],
  },
  'lib/engagementCascade.ts': {
    EXEMPT: [2, 'the cascade\'s own DELETE (two modes); every CALL of engagementCascadeIn is a site of its own, in a bumping function'],
  },
  'lib/accountDelete.ts': {
    EXEMPT: [9, 'account deletion: the version rows cascade with the user; ratings are deleted or tombstoned, keys re-labelled d: or dropped'],
  },
  'lib/sessionRehydrate.ts': {
    EXEMPT: [3, 'the rebuild: writes the record\'s values (incl. `v` from rating_versions), never Postgres'],
  },
  'lib/sessionState.ts': {
    EXEMPT: [1, 'buildRatingsView: a read'],
  },
  'lib/momentLookIn.ts': {
    EXEMPT: [1, 'the look-in\'s guest read: a read'],
  },
  'lib/sessionMutation.ts': {
    EXEMPT: [1, 'ratingKeyWrite recognising a signed-in key it wrote, for the rollback clean-up (dropUncommittedKeys: DEL + invalidate, the rebuild restores them from the record)'],
  },
  'lib/redis.ts': {
    EXEMPT: [1, 'the key\'s one spelling (k.rating)'],
  },
  'app/api/session/[code]/removed-state/route.ts': {
    EXEMPT: [1, 'a read (does the removed caller have ratings)'],
  },
  'app/api/session/[code]/bans/preview/[identityId]/route.ts': {
    EXEMPT: [1, 'a read (the ban preview\'s count)'],
  },
}

const CODE_FILE = /\.(ts|tsx|mts|mjs|js)$/
const inScope = (f) => CODE_FILE.test(f) && (f.startsWith('app/') || f.startsWith('lib/'))

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  .replace(/(^|\s)--(?=\s|$)[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

// Across line breaks (`\s` matches a newline). Calls exclude their own definition.
// A table name as SQL may spell it: bare, quoted, schema-qualified.
const TABLE = (t) => String.raw`(?:"?public"?\s*\.\s*)?"?${t}\b"?`
const SITE = new RegExp([
  String.raw`\bINSERT\s+INTO\s+` + TABLE('ratings'),
  String.raw`\bUPDATE\s+(?:ONLY\s+)?` + TABLE('ratings'),
  String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:` + TABLE('ratings') + '|' + TABLE('wines') + ')',
  String.raw`\.\s*rating\s*\.\s*(?:createManyAndReturn|createMany|create|updateManyAndReturn|updateMany|update|upsert|deleteMany|delete)\s*\(`,
  String.raw`\.\s*wine\s*\.\s*(?:delete|deleteMany)\s*\(`,
  String.raw`\bratings?\s*:\s*\{\s*(?:createMany|create|connectOrCreate|updateMany|update|upsert|deleteMany|delete|set)\s*:`,
  String.raw`(?<!function\s+)\bengagementCascadeIn\s*\(`,
  String.raw`(?<!function\s+)\bratingKeyWrite\s*\(`,
  String.raw`(?<!function\s+)\bcopyRatingKeys\s*\(`,
  String.raw`\bdropKeys\s*\.\s*push\s*\(`,
  String.raw`\bk\s*\.\s*rating\s*\(`,
  String.raw`s:\$\{[^}\x60]*\}:r:`,
].join('|'), 'gi')
const TAG = /(?:\/\/|--)\s*rating-write:\s*(BUMPS|COPIES|EXEMPT)\b/
const BUMP = /\b(?:bumpRatingVersion|bumpRaterVersions|bumpBottleVersions)\s*\(/
const COPY = /\bcopyRatingVersions\s*\(/

// The enclosing top-level block of an offset: from the last line before it that
// starts in column 0 (not a closing bracket) to the next line that starts with `}`.
function enclosing(src, at) {
  const before = src.slice(0, at)
  const starts = [...before.matchAll(/(^|\n)(?=[^\s}\])])/g)]
  const start = starts.length ? starts[starts.length - 1].index : 0
  const rest = src.slice(at)
  const end = rest.search(/\n\}/)
  return src.slice(start, end === -1 ? src.length : at + end)
}

// Each site: its line, its tag (or null), whether its block bumps / copies.
// A tag pairs with the nearest site at or below it (≤ 3 lines), once.
export function ratingSites(source) {
  const src = stripComments(source)
  const lines = source.split('\n')
  const tags = new Map()   // line → kind
  lines.forEach((l, i) => { const m = TAG.exec(l); if (m) tags.set(i + 1, m[1].toUpperCase()) })
  const used = new Set()
  const byLine = new Map()   // site line → the tag that classifies every site starting on it
  const out = []
  for (const m of src.matchAll(SITE)) {
    const line = src.slice(0, m.index).split('\n').length
    if (!byLine.has(line)) {
      let kind = null
      for (let l = line; l >= line - 3 && l >= 1; l--) {
        if (tags.has(l) && !used.has(l)) { kind = tags.get(l); used.add(l); break }
      }
      byLine.set(line, kind)
    }
    const block = enclosing(src, m.index)
    out.push({ line, kind: byLine.get(line), bumps: BUMP.test(block), copies: COPY.test(block), text: m[0].replace(/\s+/g, ' ') })
  }
  const stale = [...tags.keys()].filter(l => !used.has(l))
  return { sites: out, stale }
}

function selfTest() {
  const one = (src) => ratingSites(src).sites
  const sites = [
    ['raw insert', "await tx.$executeRaw`INSERT INTO ratings (wine_id) VALUES (1)`"],
    ['raw update, lower case', "sql`update ratings set score = 1`"],
    ['raw delete over two lines', "await tx.$executeRaw`\n  DELETE\n   FROM ratings WHERE id = 1`"],
    // (The two bottle-delete samples are split so that scripts/check-wine-writes.mjs,
    // which scans scripts/ too, does not read this file as a writer of `wines`.)
    ['a bottle delete (cascades)', 'await tx.$executeRaw`DELETE FROM ' + 'wines WHERE id = ${w}`'],
    ['prisma create', "await tx.rating.create({ data })"],
    ['prisma delete over two lines', "await prisma.rating\n  .delete({ where })"],
    ['prisma wine delete', 'await prisma.wine' + '.deleteMany({ where })'],
    ['the cascade call', "await engagementCascadeIn(tx, id, 'force')"],
    ['a key write', "await ratingKeyWrite(ctx, key, null)"],
    ['a key copy', "await copyRatingKeys(fence, moved)"],
    ['a queued key drop', "ctx.after.dropKeys.push(...keys)"],
    ['the key spelling', "const key = k.rating(c, id, w)"],
    ['a key template', "await scanKeys(`s:${code}:r:${id}:*`)"],
    ['a quoted insert', 'await tx.$executeRaw`INSERT INTO "ratings" ("wine_id") VALUES (1)`'],
    ['a quoted, schema-qualified update', 'await tx.$executeRaw`UPDATE "public"."ratings" SET "score" = 1`'],
    ['a quoted delete', 'await tx.$executeRaw`DELETE FROM "ratings" WHERE "id" = 1`'],
    ['a quoted bottle delete', 'await tx.$executeRaw`DELETE FROM "' + 'wines" WHERE "id" = ${w}`'],
    ['prisma createManyAndReturn', "await tx.rating.createManyAndReturn({ data })"],
    ['prisma updateManyAndReturn', "await tx.rating.updateManyAndReturn({ where, data })"],
    ['a nested update through a relation', "await tx.feedItem.update({ where, data: { rating: { update: { score: 1 } } } })"],
    ['a nested deleteMany over two lines', "await tx.user.update({ where, data: { ratings: {\n  deleteMany: {} } } })"],
    ['a nested create', "await tx.wine" + ".create({ data: { ratings: { create: [{ score: 1 }] } } })"],
  ]
  const notSites = [
    ['a line comment', "// INSERT INTO ratings happens in the rate POST"],
    ['a block comment', "/* DELETE FROM ratings */"],
    ['an SQL comment', "  -- UPDATE ratings below"],
    ['a read', "SELECT score FROM ratings WHERE id = 1"],
    ['the version table', "INSERT INTO rating_versions (user_id) VALUES (1)"],
    ['a version update', "UPDATE rating_versions SET version = version + 1"],
    ['a definition', "export async function ratingKeyWrite(ctx, key) {}"],
    ['a cascade definition', "export async function engagementCascadeIn(db, id) {}"],
    ['a find', "await prisma.rating.findMany({ where })"],
    ['the meta key', "await redis.get(`s:${c}:meta`)"],
    ['the quoted version table', 'INSERT INTO "rating_versions" ("user_id") VALUES (1)'],
    ['a relation read', "await prisma.user.findUnique({ where, include: { ratings: { where: { score: 5 } } } })"],
    ['a relation count', "select: { _count: { select: { ratings: true } } }"],
    ['a relation filter on a date', "await prisma.feedItem.findMany({ where: { rating: { createdAt: { gte } } } })"],
    ['a relation filter, deletedAt / updatedAt', "where: { ratings: { deletedAt: null } }, orderBy: { rating: { updatedAt: 'desc' } }"],
  ]
  const tagged = [
    ['a tag on the line above', "async function a(tx) {\n  // rating-write: BUMPS\n  await tx.$executeRaw`DELETE FROM ratings`\n  await bumpRatingVersion(tx, 1, 'w', null)\n}\n", 'BUMPS', true],
    ['a bump BEFORE the site, same function', "async function a(tx) {\n  await bumpRaterVersions(tx, 1, 2)\n  // rating-write: BUMPS\n  await tx.$executeRaw`DELETE FROM ratings`\n}\n", 'BUMPS', true],
    ['a bump only in the NEXT function', "async function a(tx) {\n  // rating-write: BUMPS\n  await tx.$executeRaw`DELETE FROM ratings`\n}\nasync function b(tx) {\n  await bumpRatingVersion(tx, 1, 'w', null)\n}\n", 'BUMPS', false],
    ['an SQL tag inside the template', "async function a(tx) {\n  await tx.$executeRaw`\n    -- rating-write: EXEMPT\n    DELETE FROM ratings`\n}\n", 'EXEMPT', false],
    ['a tag too far above', "async function a(tx) {\n  // rating-write: EXEMPT\n\n\n\n\n  await tx.$executeRaw`DELETE FROM ratings`\n}\n", null, false],
  ]
  const bad = [
    ...sites.filter(([, src]) => one(src).length !== 1).map(([n]) => `missed a site: ${n}`),
    ...notSites.filter(([, src]) => one(src).length !== 0).map(([n]) => `flagged a non-site: ${n}`),
    ...tagged.filter(([, src, kind, bumps]) => { const s = one(src)[0]; return !s || s.kind !== kind || s.bumps !== bumps }).map(([n]) => `wrong tag or block: ${n}`),
  ]
  // One tag serves one LINE of sites; a site on the next line is untagged, a tag with no site is stale.
  const two = ratingSites("async function a(tx) {\n  // rating-write: BUMPS\n  await ratingKeyWrite(ctx, k.rating(c, i, w), null)\n  await ratingKeyWrite(ctx, k2, null)\n  await bumpRatingVersion(tx, 1, 'w', null)\n}\n")
  if (two.sites.length !== 3 || two.sites.filter(s => s.kind).length !== 2) bad.push('one tag must classify its own line only')
  if (ratingSites("// rating-write: EXEMPT\nconst x = 1\n").stale.length !== 1) bad.push('a stale tag went unnoticed')
  if (bad.length) { console.error('check-rating-writes: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return sites.length + notSites.length + tagged.length + 2
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-rating-writes: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope)
if (files.length === 0) { console.error('check-rating-writes: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
const problems = []
for (const file of files) {
  if (!existsSync(file)) continue
  const { sites, stale } = ratingSites(readFileSync(file, 'utf8'))
  for (const l of stale) problems.push(`${file}:${l}: a rating-write tag with no site within 3 lines below it`)
  if (sites.length) found[file] = sites
}
if (process.argv.includes('--list')) {
  for (const [file, sites] of Object.entries(found)) for (const s of sites) console.log(`${s.kind ?? 'UNTAGGED'}\t${file}:${s.line}\t${s.text}`)
}
for (const [file, sites] of Object.entries(found)) {
  const pin = EXPECTED[file]
  const untagged = sites.filter(s => !s.kind)
  for (const s of untagged) problems.push(`${file}:${s.line}: an untagged rating write / key site (${s.text}): tag it BUMPS / COPIES / EXEMPT and pin it`)
  if (!pin) { problems.push(`${file}: ${sites.length} rating site(s) in a file not on the list`); continue }
  for (const kind of ['BUMPS', 'COPIES', 'EXEMPT']) {
    const n = sites.filter(s => s.kind === kind).length
    const [want, why] = pin[kind] ?? [0, '']
    if (n !== want) problems.push(`${file}: ${n} ${kind} site(s), pinned at ${want}${why ? ` (${why})` : ''}`, ...sites.filter(s => s.kind === kind).map(s => `    ${file}:${s.line} ${s.text}`))
  }
  for (const s of sites) {
    if (s.kind === 'BUMPS' && !s.bumps) problems.push(`${file}:${s.line}: a BUMPS site whose function calls no version bump (lib/ratingVersions.ts)`)
    if (s.kind === 'COPIES' && !s.copies) problems.push(`${file}:${s.line}: a COPIES site whose function copies no version rows (copyRatingVersions)`)
  }
}
for (const [file, pin] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`${file}: pinned (${Object.entries(pin).map(([k, [n]]) => `${k} ${n}`).join(', ')}) but has no rating sites now: lower the pin (or remove the entry)`)
}
if (problems.length === 0) {
  const all = Object.values(found).flat()
  const by = (k) => all.filter(s => s.kind === k).length
  console.log(`check-rating-writes: OK — ${all.length} rating sites in ${Object.keys(found).length} listed files (BUMPS ${by('BUMPS')}, COPIES ${by('COPIES')}, EXEMPT ${by('EXEMPT')}; ${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-rating-writes: FAILED: a session-rating write or rating-key site changed.')
console.error('Every write of a signed-in session rating bumps its version in the same transaction')
console.error('(lib/ratingVersions.ts; docs/dev/rating-saves.md § The writers). Tag the site')
console.error('`// rating-write: BUMPS | COPIES | EXEMPT` and pin it in scripts/check-rating-writes.mjs.\n')
for (const p of problems) console.error(`  ${p}`)
process.exit(1)
