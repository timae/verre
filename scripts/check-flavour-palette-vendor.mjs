#!/usr/bin/env node
// CI gate: the vendored native flavour palette must match the full palette.
//
// Why this exists — the flavour-viz colours live in three places by design:
//   1. .local/design/flavour-palette.js   — the design source (gitignored)
//   2. apps/mobile/src/theme/flavour-palette/palette.js — the tracked full copy
//   3. apps/mobile/src/theme/flavourColors.ts — the VENDORED runtime subset
//      (the 8 wine axes the input actually renders), keyed by registry key.
// (1) is invisible to CI; (2)↔(3) is fully CI-visible. The vendored subset
// silently drifting from the full palette = wrong wedge colours on the wheel +
// fill-track input, with nothing to catch it. This repo's stance is
// safe-by-construction, not safe-by-discipline (root CLAUDE.md; cf.
// check-mobile-design-tokens, check-identity-writes, check-no-eas-projectid), so
// a three-copy palette gets a gate. This one enforces (2)→(3): every vendored
// wine-8 colour equals the mapped `structure` label in the full palette.
// See apps/mobile/src/theme/flavour-palette/CLAUDE.md.
//
// A dependency-free static check (reads tracked files via `git ls-files`),
// matching the other check-*.mjs gates.
//
// Run: node scripts/check-flavour-palette-vendor.mjs   (exits 1 on drift)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FULL = 'apps/mobile/src/theme/flavour-palette/palette.js'
const VENDORED = 'apps/mobile/src/theme/flavourColors.ts'

// registry key (in flavourColors.ts) → design-palette `structure` label (in
// palette.js). Keep in lockstep with the CLAUDE.md mapping table.
const KEY_TO_LABEL = {
  sweet: 'Sweetness',
  acid: 'Acidity',
  body: 'Body',
  tannin: 'Tannin',
  finish: 'Finish',
  aroma: 'Aroma',
  flavour: 'Flavour',
  bubbles: 'Bubbles',
}

// Empty-scope guard: fail loud if either file isn't tracked here (run from a
// subdir, or a file was moved/renamed) — else the gate passes green guarding
// nothing. CI runs from the repo root. (Same idiom as the sibling gates.)
for (const target of [FULL, VENDORED]) {
  const tracked = execSync(`git ls-files "${target}"`, { encoding: 'utf8' }).trim()
  if (!tracked) {
    console.error(`check-flavour-palette-vendor: ERROR — ${target} is not tracked here. Run from the repo root (or the file moved — update the path).`)
    process.exit(1)
  }
}

const norm = (hex) => hex.trim().toLowerCase()

// Pull `<theme>: { structure: { Label: '#hex', … }, aroma: {…} }` out of the
// full palette. Scoped to each theme's `structure` block so an aroma key with
// the same label (e.g. aroma "Sweet") can't be read in place of a structure one.
function parseFullStructure(src) {
  const out = {}
  // Each theme block: `apricot: {  bg: '…', structure: { … }, aroma: { … } },`
  const themeRe = /(\w+):\s*\{\s*bg:\s*'[^']*',\s*structure:\s*\{([\s\S]*?)\},\s*aroma:/g
  let m
  while ((m = themeRe.exec(src)) !== null) {
    const theme = m[1]
    const block = m[2]
    const colors = {}
    const kvRe = /'?([\w/]+)'?:\s*'(#[0-9a-fA-F]{3,8})'/g
    let kv
    while ((kv = kvRe.exec(block)) !== null) colors[kv[1]] = kv[2]
    out[theme] = colors
  }
  return out
}

// Pull `<theme>: { sweet: '#hex', … }` out of the vendored FLAVOUR_COLORS map.
function parseVendored(src) {
  const body = src.slice(src.indexOf('FLAVOUR_COLORS'))
  const out = {}
  const themeRe = /(\w+):\s*\{([^}]*)\}/g
  let m
  while ((m = themeRe.exec(body)) !== null) {
    const theme = m[1]
    const block = m[2]
    if (!/\bsweet:/.test(block)) continue // skip non-theme braces
    const colors = {}
    const kvRe = /(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g
    let kv
    while ((kv = kvRe.exec(block)) !== null) colors[kv[1]] = kv[2]
    out[theme] = colors
  }
  return out
}

const full = parseFullStructure(readFileSync(FULL, 'utf8'))
const vendored = parseVendored(readFileSync(VENDORED, 'utf8'))

const themes = Object.keys(vendored)
if (themes.length === 0) {
  console.error('check-flavour-palette-vendor: ERROR — parsed 0 themes from the vendored file. The format changed; update the parser.')
  process.exit(1)
}

const problems = []
for (const theme of themes) {
  const srcStruct = full[theme]
  if (!srcStruct) {
    problems.push(`theme "${theme}" is vendored but missing from the full palette`)
    continue
  }
  for (const [key, label] of Object.entries(KEY_TO_LABEL)) {
    const got = vendored[theme][key]
    const want = srcStruct[label]
    if (!got) problems.push(`${theme}.${key} missing from vendored palette`)
    else if (!want) problems.push(`${theme}: structure label "${label}" (for key ${key}) missing from full palette`)
    else if (norm(got) !== norm(want)) problems.push(`${theme}.${key} (${label}) drift: vendored ${got} ≠ full ${want}`)
  }
}

if (problems.length) {
  console.error('check-flavour-palette-vendor: FAILED — vendored flavour colours drift from the full palette.\n')
  for (const p of problems) console.error(`  • ${p}`)
  console.error(`\nRe-vendor ${VENDORED} from ${FULL} (structure block, per the key→label map).`)
  console.error('See apps/mobile/src/theme/flavour-palette/CLAUDE.md.')
  process.exit(1)
}

const count = themes.length * Object.keys(KEY_TO_LABEL).length
console.log(`check-flavour-palette-vendor: OK — ${count} vendored wine colours (${themes.length} themes × 8 axes) match the full palette.`)
