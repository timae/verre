#!/usr/bin/env node
// Structural gate for the vintage free-text field.
//
// WHY THIS EXISTS: the unit suite (scripts/tests/vintage-text-units.ts) pins the
// @verre/core helper's BEHAVIOUR, but it cannot see whether the surfaces
// actually call it. Reintroducing `replace(/\D/g, '')` in one component would
// leave every unit pin green while restoring the original bug.
//
// ⚠️ THE FIRST VERSION OF THIS GATE WAS BYPASSABLE and review proved it with
// three mutations that all passed: it asserted only that a FILE MENTIONED the
// helper, so deleting a submit-boundary call left the import (or, in
// AddWineModal, the scanner's unrelated call) satisfying the check. A
// file-level mention is not a call site. This version asserts named call sites
// individually, and additionally DISCOVERS vintage surfaces rather than
// trusting the manual list.
//
// Still deliberately regex-shaped rather than a TS AST walk: the failure mode
// being guarded is a deleted or copy-pasted one-liner, and every assertion below
// names the exact expression it requires, so a rename fails loudly rather than
// silently passing. False positives are preferable to a silent regression.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const problems = []

function read(rel) {
  try {
    return readFileSync(rel, 'utf8')
  } catch {
    problems.push(`${rel}: listed in the gate but not readable — update scripts/check-vintage-wiring.mjs if the file moved`)
    return null
  }
}

// ── 1. Required call sites ─────────────────────────────────────────────────
//
// Each entry names ONE required expression. Removing any single call fails the
// gate even if the file still imports the helper or calls it elsewhere — that
// is exactly the bypass the first version allowed.
//
// `label` describes the boundary; `must` is a regex for the call itself.
const CALL_SITES = [
  // Client input surfaces — per-keystroke filter.
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'session add/edit: vintage input filter', must: /setVintage\(filterVintageInput\(/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/check-in/index.tsx', label: 'check-in create: vintage input filter', must: /setVintage\(filterVintageInput\(/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/edit/details.tsx', label: 'check-in edit: vintage input filter', must: /setVintage\(filterVintageInput\(/ },

  // Client submit boundaries — canonicalize before sending.
  // Canonicalization for this form lives in the tested payload builder (see 1b).
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'session add/edit: payload builder', must: /buildImpressionPayload\(/ },
  { file: 'apps/mobile/src/lib/impressionPayload.ts', label: 'payload builder: vintage canonicalization', must: /normalizeVintageText\(fields\.vintage\)/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/check-in/rate.tsx', label: 'check-in create: submit canonicalization', must: /normalizeVintageText\(draft\.vintage\)/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/edit/details.tsx', label: 'check-in edit: store canonicalization', must: /vintage:\s*normalizeVintageText\(vintage\)/ },
  { file: 'components/wine/AddWineModal.tsx', label: 'web session add/edit: submit canonicalization', must: /vintage:\s*normalizeVintageText\(vintage\)/ },
  { file: 'components/social/CheckinModal.tsx', label: 'web check-in: submit canonicalization', must: /vintage:\s*normalizeVintageText\(vintage\)/ },
  // The label scanner is a SEPARATE boundary in the same file — it must not be
  // able to satisfy the submit assertion above (that masking is what let a
  // dropped submit call pass review's mutation).
  { file: 'components/wine/AddWineModal.tsx', label: 'web label scanner: canonicalize extracted value', must: /setVintage\(normalizeVintageText\(gotVintage\)\)/ },

  // Server persistence boundaries — the authority. A direct client can post
  // anything, so these carry correctness rather than UX.
  { file: 'lib/session.ts', label: 'session wine write', must: /vintage:\s*normalizeVintageText\(/ },
  { file: 'app/api/checkins/route.ts', label: 'standalone check-in POST', must: /normalizeVintageText\(scrub\(vintage\)/ },
  { file: 'app/api/checkins/[id]/route.ts', label: 'standalone check-in PATCH', must: /normalizeVintageText\(scrub\(vintage\)/ },

  // The catalog-link comparator must model the write EXACTLY, including its
  // type handling — see the numeric-2019 defect in lib/catalogWrite.ts.
  { file: 'lib/catalogWrite.ts', label: 'catalog-link comparator', must: /field === 'vintage'\)\s*s = normalizeVintageText\(s\)/ },
]

for (const { file, label, must } of CALL_SITES) {
  const src = read(file)
  if (src === null) continue
  if (!must.test(src)) {
    problems.push(`${file}: MISSING call site — ${label}\n      expected to match: ${must}`)
  }
}

// 🔒 The comparator must NOT stringify. `scrub` rejects non-strings, so a
// String(v) coercion makes the comparator more permissive than the write and
// re-opens the numeric-2019 blank-vintage-with-retained-link defect.
{
  const src = read('lib/catalogWrite.ts')
  if (src && /scrub\(\s*typeof v === 'string'[^)]*String\(v\)/.test(src)) {
    problems.push(`lib/catalogWrite.ts: comparator stringifies non-string values — the write path uses scrub(v), which rejects them. This re-opens the numeric-vintage defect (comparator keeps the link, write stores '').`)
  }
}

// ── 1b. The mode-aware edit payload ───────────────────────────────────────
// The mobile session form serves BOTH add and edit. On ADD, omitting an empty
// optional is right; on EDIT, omitting it means "unchanged", so a CLEARED field
// silently keeps its old value — and for vintage that left a blank vintage still
// carrying a vintage-grain catalog link.
//
// ⚠️ The FIRST version of this check asserted only that `isEditMode` and an
// `optional()` helper EXISTED. Review proved the bypass: changing
// `vintage: optional(cleanVintage)` to `vintage: cleanVintage || undefined`
// passed, because nothing checked that vintage USED the helper. So the shape now
// lives in ONE tested production module and this asserts the component CALLS it
// — behaviour is pinned by scripts/tests/impression-payload-units.ts.
{
  const f = 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx'
  const src = read(f)
  if (src) {
    // 🔒 REQUIRE THE DATA-FLOW ASSIGNMENT, not merely a call somewhere. Review
    // proved the bypass: `const checkedButUnused = buildImpressionPayload(...)`
    // beside a locally-assembled `const base = {...}` satisfied a
    // "calls the helper" check while reintroducing empty-vintage omission on
    // edit — every behavioural test stayed green because the helper still
    // behaved, it was just IGNORED. A tested helper whose result is discarded is
    // indistinguishable from no helper at all.
    if (!/const base = buildImpressionPayload\(/.test(src)) {
      problems.push(`${f}: the payload must be ASSIGNED from buildImpressionPayload (expected \`const base = buildImpressionPayload(\`). A call whose result is unused leaves the inline shape live while the behavioural tests still pass.`)
    }
    // Catch a locally-assembled payload object even if the helper is also called.
    if (/const base = \{/.test(src)) {
      problems.push(`${f}: \`const base = { ... }\` is assembled INLINE — the add-vs-edit shape must come from buildImpressionPayload, or a cleared field is sent as omitted (i.e. "unchanged") on EDIT.`)
    }
    if (/vintage:\s*(cleanVintage|optional\(|vintage\.trim\(\))/.test(src)) {
      problems.push(`${f}: vintage is assembled INLINE in the payload — use buildImpressionPayload so the add-vs-edit behaviour stays tested.`)
    }
    if (/\.\.\.\(vintage\.trim\(\) \? \{ vintage/.test(src) || /\.\.\.\(cleanVintage \? \{ vintage/.test(src)) {
      problems.push(`${f}: vintage is spread-omitted when empty — on EDIT that means "unchanged", leaving a cleared vintage with a retained catalog link.`)
    }
  }
}

// ── 1c. The scanner coercion must be the PRODUCTION helper ────────────────
// An earlier cut implemented coercion locally in the component and tested a COPY
// of it, so mutating production to accept floats left the suite green.
{
  const f = 'components/wine/AddWineModal.tsx'
  const src = read(f)
  if (src) {
    // 🔒 EXACT ASSIGNMENTS, PER FIELD. Same disconnected-helper bypass as the
    // payload builder: `const checkedVintage = scanVintage(result.vintage)`
    // beside a local ternary coercion satisfied a "calls the helper somewhere"
    // check while the value actually used came from the local copy (which could
    // accept floats). And a single generic `scanText(result.` occurrence let
    // three of the four text fields go uncoerced.
    const SCAN_FIELDS = [
      ['vintage', /const gotVintage = scanVintage\(result\.vintage\)/, 'scanVintage'],
      ['name', /const gotName = scanText\(result\.name\)/, 'scanText'],
      ['producer', /const gotProducer = scanText\(result\.producer\)/, 'scanText'],
      ['grape', /const gotGrape = scanText\(result\.grape\)/, 'scanText'],
      ['type', /const gotType = scanText\(result\.type\)/, 'scanText'],
    ]
    for (const [field, re, helper] of SCAN_FIELDS) {
      if (!re.test(src)) {
        problems.push(`${f}: scanner field '${field}' is not ASSIGNED from ${helper}() (expected ${re}). A helper call whose result is discarded leaves local coercion live while the helper's own tests still pass.`)
      }
    }
    // The value that reaches state must be the coerced one.
    if (!/setVintage\(normalizeVintageText\(gotVintage\)\)/.test(src)) {
      problems.push(`${f}: the scanned vintage written to state must be normalizeVintageText(gotVintage) — i.e. the value that came from scanVintage.`)
    }
    // A re-inlined local coercion helper is the regression.
    if (/const asText\s*=|const toText\s*=/.test(src)) {
      problems.push(`${f}: declares a LOCAL coercion helper — import scanText/scanVintage from @verre/core instead, so the tests exercise shipped behaviour.`)
    }
  }
}

// ── 2. Forbidden patterns on vintage lines ────────────────────────────────
const FORBIDDEN = [
  { re: /replace\(\s*\/\\D\/g/, why: 'digit-strip on a vintage field — this is the original bug (makes "NV" untypeable). Use filterVintageInput.' },
  { re: /keyboardType\s*=\s*["'{]?\s*['"]?number-pad/, why: 'number-pad keyboard on a vintage field — letters are unreachable, so "NV" cannot be typed.' },
]

// ── 3. DISCOVERY — find vintage surfaces the list above doesn't name ───────
// Relying only on a manual list means a NEW screen with a vintage field is
// unguarded until someone remembers to add it. Walk the client trees, flag any
// file that renders a vintage input but isn't covered by a CALL_SITES entry.
const CLIENT_ROOTS = ['components', 'apps/mobile/src']
const SKIP_DIRS = new Set(['node_modules', '.next', 'ios', 'android', 'dist', 'build'])
const listed = new Set(CALL_SITES.map((c) => c.file))

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

for (const root of CLIENT_ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    // A vintage INPUT surface, not merely a file that reads a vintage for
    // display: it owns a vintage setter or declares a Vintage-labelled field.
    const isInput = /setVintage\(/.test(src) || /label\s*=\s*["']Vintage["']/.test(src) || /className="fl">vintage/.test(src)
    if (!isInput) continue
    if (!listed.has(file)) {
      problems.push(`${file}: renders a vintage input but is NOT covered by scripts/check-vintage-wiring.mjs. Add a CALL_SITES entry asserting it filters input and canonicalizes on submit.`)
    }
    // Forbidden patterns, checked on vintage-relevant lines only (a `position`
    // field is legitimately digits-only, so a file-wide scan would false-fire).
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (!/vintage/i.test(line)) return
      for (const { re, why } of FORBIDDEN) {
        if (re.test(line)) problems.push(`${file}:${i + 1}: ${why}`)
      }
    })
    // Also catch the multi-line JSX shape: a Vintage-labelled field whose
    // props block carries a forbidden pattern a line or two below the label.
    const blocks = src.match(/label\s*=\s*["']Vintage["'][\s\S]{0,400}?\/>/g) ?? []
    for (const block of blocks) {
      for (const { re, why } of FORBIDDEN) {
        if (re.test(block)) problems.push(`${file}: Vintage field block — ${why}`)
      }
    }
  }
}

if (problems.length) {
  console.error('check-vintage-wiring: FAIL\n')
  for (const p of problems) console.error('  ' + p)
  console.error('\nThe vintage field accepts a 4-digit year OR the literal NV token.')
  console.error('Behaviour is pinned by scripts/tests/vintage-text-units.ts; this gate pins the WIRING.')
  process.exit(1)
}

const inputs = new Set(CALL_SITES.map((c) => c.file)).size
console.log(
  `check-vintage-wiring: OK — ${CALL_SITES.length} required call sites across ${inputs} files, no digit-strips, no number-pad, no unlisted vintage surfaces.`,
)
