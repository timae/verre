#!/usr/bin/env node
// ── Attributions parity gate ───────────────────────────────────────────────
//
// The legal attribution entries exist TWICE by design:
//   • lib/attributions.ts               DEFAULT_ENTRIES   (server / web)
//   • apps/mobile/src/lib/api/legal.ts  BUNDLED_ATTRIBUTIONS (native fallback)
//
// The native app cannot read server env, so it fetches the entries and falls
// back to a bundled snapshot when offline. That fallback is what keeps a LEGAL
// surface from rendering blank — and it is also how the two copies can drift.
//
// 🔒 DRIFT HERE IS A LICENCE PROBLEM, NOT A STYLE PROBLEM. If the server entry
// is corrected and the snapshot is not, an offline user is shown superseded
// legal terms with no tell. This gate fails the build on any divergence.
//
// It compares the fields that carry legal meaning, BYTE-FOR-BYTE — including
// the verbatim MIT block and the OGL-BC en dash (U+2013). No trimming, no
// normalisation: that is the entire point.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = 'lib/attributions.ts'
const MOBILE = 'apps/mobile/src/lib/api/legal.ts'

// Pull an array literal out of a TS source by brace-matching from its
// declaration, then evaluate it. The files are repo-controlled, not input.
function extractArray(src, declaration) {
  // Anchor on the DECLARATION, not any mention: both files reference these
  // names in prose comments before declaring them, and matching the comment
  // yields an empty parse.
  const declRe = new RegExp(`(?:const|let|var)\\s+${declaration}\\b`)
  const m = declRe.exec(src)
  if (!m) throw new Error(`could not find a declaration of "${declaration}"`)
  const start = m.index
  // Anchor on the ASSIGNMENT, not the declaration name: the type annotation
  // (`: AttributionEntry[] =`) contains a `[` that would otherwise be matched
  // as the start of the literal, yielding an empty array and a gate that
  // passes while comparing nothing.
  const eq = src.indexOf('=', start)
  if (eq === -1) throw new Error(`no assignment after "${declaration}"`)
  const open = src.indexOf('[', eq)
  if (open === -1) throw new Error(`no array literal after "${declaration}"`)
  let depth = 0
  let inStr = null
  let escaped = false
  // ⚠️ COMMENTS MUST BE SKIPPED. These entries carry prose containing
  // apostrophes ("BC's own resource"), and treating one as a string delimiter
  // desynchronises the scanner and reports an unterminated literal.
  let inLine = false
  let inBlock = false
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && src[i + 1] === '/') { inBlock = false; i++ } continue }
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (inStr) { if (c === inStr) inStr = null; continue }
    if (c === '/' && src[i + 1] === '/') { inLine = true; i++; continue }
    if (c === '/' && src[i + 1] === '*') { inBlock = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        const literal = src.slice(open, i + 1)
        return new Function(`return (${literal})`)()
      }
    }
  }
  throw new Error(`unterminated array literal after "${declaration}"`)
}

let serverEntries, mobileEntries
try {
  serverEntries = extractArray(readFileSync(join(root, SERVER), 'utf8'), 'DEFAULT_ENTRIES')
  mobileEntries = extractArray(readFileSync(join(root, MOBILE), 'utf8'), 'BUNDLED_ATTRIBUTIONS')
} catch (err) {
  console.error(`FAIL: could not parse the attribution entries — ${err.message}`)
  console.error('If the declarations were renamed, update this gate rather than removing it.')
  process.exit(1)
}

const errors = []

// 🔒 A gate that parses zero entries would pass while checking NOTHING —
// the "green suite that misses every regression" failure. Assert the parse
// actually found the entries before comparing them.
if (serverEntries.length === 0 || mobileEntries.length === 0) {
  console.error(`FAIL: parsed ${serverEntries.length} server / ${mobileEntries.length} mobile entries — at least one side came back EMPTY.`)
  console.error('This gate cannot verify anything in that state. Fix the extractor; do not relax the check.')
  process.exit(1)
}

if (serverEntries.length !== mobileEntries.length) {
  errors.push(`entry count differs: ${SERVER} has ${serverEntries.length}, ${MOBILE} has ${mobileEntries.length}`)
}

// 🔒 Every field below carries legal meaning. `notes` is included because it is
// what an unverified entry RENDERS as its visible caveat.
const FIELDS = ['source', 'sourceUrl', 'attribution', 'verified', 'notes', 'dataPeriod']

for (const s of serverEntries) {
  const m = mobileEntries.find((e) => e.source === s.source)
  if (!m) { errors.push(`"${s.source}" is in ${SERVER} but missing from ${MOBILE}`); continue }
  for (const f of FIELDS) {
    if (s[f] !== m[f]) {
      errors.push(`"${s.source}" field \`${f}\` differs:\n    server: ${JSON.stringify(s[f])}\n    mobile: ${JSON.stringify(m[f])}`)
    }
  }
  if (s.licence.spdx !== m.licence.spdx) {
    errors.push(`"${s.source}" licence.spdx differs: ${JSON.stringify(s.licence.spdx)} vs ${JSON.stringify(m.licence.spdx)}`)
  }
  // 🔒 The licence URL is the COMPLIANCE-relevant link — CC BY requires "provide
  // a link to the license" and OGL-BC requires a link to the licence. It is a
  // separate field from sourceUrl precisely because conflating them left the
  // LWIN entry linking a dataset page instead of a licence.
  if (s.licence.url !== m.licence.url) {
    errors.push(`"${s.source}" licence.url differs: ${JSON.stringify(s.licence.url)} vs ${JSON.stringify(m.licence.url)}`)
  }
  // Byte-for-byte. A trailing newline difference is a real difference here.
  if (s.licence.text !== m.licence.text) {
    errors.push(`"${s.source}" licence.text differs BYTE-FOR-BYTE (server ${s.licence.text.length} chars, mobile ${m.licence.text.length}). This text is reproduced verbatim under licence — do not normalise either copy; make them identical.`)
  }
}

for (const m of mobileEntries) {
  if (!serverEntries.find((e) => e.source === m.source)) {
    errors.push(`"${m.source}" is in ${MOBILE} but missing from ${SERVER}`)
  }
}

// 🔒 No unverified entry may ship. The `verified` flag exists so a best-guess
// paraphrase cannot silently become the record; this is the assertion that
// makes the flag mean something.
for (const s of serverEntries) {
  if (s.verified !== true) {
    errors.push(`"${s.source}" has verified:false — an unverified entry must not ship. Confirm the wording against the primary source, or remove the entry.`)
  }
  if (!s.notes || !s.notes.trim()) {
    errors.push(`"${s.source}" has an empty \`notes\` — it must record why \`verified\` holds its value.`)
  }
  // 🔒 Both links must EXIST, because both are rendered and one of them is how
  // CC BY / OGL-BC compliance is actually satisfied.
  if (!s.sourceUrl || !/^https?:\/\//.test(s.sourceUrl)) {
    errors.push(`"${s.source}" has a missing or non-http \`sourceUrl\`.`)
  }
  if (!s.licence.url || !/^https?:\/\//.test(s.licence.url)) {
    errors.push(`"${s.source}" has a missing or non-http \`licence.url\` — this is the link the licence REQUIRES; it cannot be blank.`)
  }
}

// 🔒 The OGL-BC statement's dash is an EN DASH (U+2013), verified at source.
// BC's own page title uses an ASCII hyphen, so both forms appear in one
// document and a normalisation would alter a legally required string.
for (const [file, entries] of [[SERVER, serverEntries], [MOBILE, mobileEntries]]) {
  const bc = entries.find((e) => e.licence.spdx.startsWith('OGL-BC'))
  if (bc && !bc.attribution.includes('–')) {
    errors.push(`${file}: the OGL-BC attribution statement has lost its EN DASH (U+2013) — it appears to have been normalised to a hyphen. Restore the exact character.`)
  }
}

if (errors.length) {
  console.error('FAIL: legal attribution entries are inconsistent.\n')
  for (const e of errors) console.error(`  • ${e}`)
  console.error(`\nThese entries satisfy licence obligations. Both copies must agree exactly.`)
  process.exit(1)
}

console.log(`OK: ${serverEntries.length} attribution entries agree across ${SERVER} and ${MOBILE}.`)
