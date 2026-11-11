#!/usr/bin/env node
// CI gate: the POST-READ census (You profile, step 4). Every read of another
// user's posts must go through the post gate (`canViewPosts` /
// `resolveProfileViewer().sees.posts` / `viewerCanSeePosts`,
// lib/profileVisibility.ts): profile tier + Check-Ins Visible To, and the
// place rule (`postPlace`). A read path that skips it leaks a post. This
// gate makes a NEW read path visible: every line that reads feed_items /
// feed_item_likes / feed_item_tags in app/ + lib/ must sit in a file on the
// allow-list below, and each file's count is PINNED, so a new read in an
// already-listed file fails too. Adding or raising an entry is a privacy
// review: name the gate the read goes through.
//
// It matches READS only (writes are not a leak; `DELETE FROM feed_items` is
// skipped, like check-identity-writes.mjs matches writes only):
//  - Prisma:   `feedItem|feedItemLike|feedItemTag . find*|count|aggregate|groupBy`
//  - raw SQL:  `FROM|JOIN [public.]feed_items|feed_item_likes|feed_item_tags`
//  - relation: `feedItems|feedItem|feedItemLikes|feedItemTags: { | true`
//    (an include / select / _count reaching posts through another model)
//
// ⚠️ BLIND SPOT (a grep gate, not a type system): post CONTENT also lives in
// `ratings` / `rating_images` (scores, notes, photos), cravings in
// `bookmarks`, memberships in `session_members`; none of those tables is
// matched (they have many legitimate own-only / in-session readers). Those are
// covered by the REQUIRED gate / tile-list parameters on the profile loaders
// (loadProfile / loadProfileHeaderExtras take the gate, resolveTilePhotos the
// shown tiles; no defaults) and by the leak matrix in
// scripts/tests/you-profile-integration.mts § 11. It pins COUNTS, not reads:
// swapping a gated read for an ungated one in a listed file keeps the count.
// Also evading it: a multi-line SQL `FROM` with the table on the next line, an
// aliased model (`const t = prisma.feedItem; t.findMany()`), a dynamic table
// name. Keep reads in the literal forms so the gate sees them.
//
// Run: node scripts/check-post-reads.mjs   (exits 1 on any violation)

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

// file → [pinned read count, the gate those reads go through]
const ALLOWED = {
  'app/api/feed/route.ts': [4, 'the feed: networkAuthors (canViewPosts) / ?user= gate.sees.posts; likes of the gated page'],
  'lib/profileLoad.ts': [4, 'the web profile posts: only when gate.sees.posts; likes of those posts'],
  'app/api/feed-items/[id]/like/route.ts': [4, 'like POST viewerCanSeePosts / DELETE the D11 rule; the count only after the gate'],
  'app/api/checkins/route.ts': [1, 'had a sip source: viewerCanSeePosts'],
  'app/api/checkins/[id]/route.ts': [3, 'owner-only edit / delete lookups (wrong owner = 404)'],
}

const PRISMA_READ = /\b(feedItem|feedItemLike|feedItemTag)\s*\.\s*(find\w*|count|aggregate|groupBy)\b/
const SQL_READ = /(?<!DELETE\s+)\b(FROM|JOIN)\s+("?public"?\.)?"?feed_item(s|_likes|_tags)\b/i
const RELATION_READ = /\b(feedItems?|feedItemLikes|feedItemTags)\s*:\s*(\{|true\b)/

const inScope = (f) => (f.startsWith('app/') || f.startsWith('lib/')) && /\.(ts|tsx|mts|mjs|js)$/.test(f)
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(inScope)
if (files.length === 0) {
  console.error('check-post-reads: ERROR — 0 in-scope files. Run from the repo root.')
  process.exit(1)
}

const hits = new Map()
for (const file of files) {
  if (!existsSync(file)) continue
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\*|\/\*)/.test(line)) return // block-comment lines
    const code = line.replace(/\/\/.*$/, '') // line comments
    if (!PRISMA_READ.test(code) && !SQL_READ.test(code) && !RELATION_READ.test(code)) return
    if (!hits.has(file)) hits.set(file, [])
    hits.get(file).push(`${file}:${i + 1}  ${line.trim()}`)
  })
}

const problems = []
for (const [file, lines] of hits) {
  const pin = ALLOWED[file]
  if (!pin) problems.push(`${file}: ${lines.length} post read(s) in a file not on the allow-list`, ...lines.map((l) => `    ${l}`))
  else if (lines.length !== pin[0]) problems.push(`${file}: ${lines.length} post read(s), pinned at ${pin[0]} (${pin[1]})`, ...lines.map((l) => `    ${l}`))
}
for (const [file, [n]] of Object.entries(ALLOWED)) {
  if (!hits.has(file)) problems.push(`${file}: pinned at ${n} but has no post reads now: lower the pin (or remove the entry)`)
}

if (problems.length === 0) {
  console.log(`check-post-reads: OK — ${[...hits.values()].flat().length} post reads in ${hits.size} allow-listed files (${files.length} files scanned)`)
  process.exit(0)
}
console.error('check-post-reads: FAILED — a read of feed_items / feed_item_likes / feed_item_tags changed.')
console.error('Every post read must go through the post gate (lib/profileVisibility.ts: canViewPosts /')
console.error('gate.sees.posts / viewerCanSeePosts, and postPlace for the place line). If the new read is')
console.error('gated (or own-only), update its pin in scripts/check-post-reads.mjs with the gate it uses.\n')
for (const p of problems) console.error(`  ${p}`)
process.exit(1)
