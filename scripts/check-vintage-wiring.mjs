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

// Code without the comments that comment code OUT: a JSX `{/* … */}`, a
// whole `//` line, and a trailing ` // …` on a line with nothing quoted before
// it (review r3 / r5: a box or a pin in one is not wiring). Only those (review
// r4): a bare `/*` or a `//` after a quote also occurs inside strings
// (`accept="image/*"`, a URL, a template), and stripping from there deletes
// live code. Named residual: a pin inside a plain `/* … */` block still counts.
const uncomment = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/^([^'"`\n]*?)[ \t]+\/\/.*$/gm, '$1')
// A listed file's code, uncommented (every pin reads it through here).
function read(rel) {
  try {
    return uncomment(readFileSync(rel, 'utf8'))
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
  // The app (catalogue model change step 7, ADR-0009): every bottle is a
  // catalogue wine picked in ONE component, the bottle picker; the year is a
  // field beside an NV tick chip (ruled 2026-07-26: ticking it clears and
  // disables the year and sends a real `year: null`). The three screens hold
  // the picker and send its link; the year rules are pure in catalogChoice.
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'app add / edit impression: the bottle picker, its back stepping through it', must: /<BottlePicker\s+\{\.\.\.pickerBack\.pickerProps\}/ },
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'app add impression: the picked link on the wire', must: /\.\.\.linkBody\(choice!\)/ },
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'app edit impression: a re-link on the wire', must: /\.\.\.\(choice \? linkBody\(choice\) : \{\}\)/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/check-in/index.tsx', label: 'app check-in create: the bottle picker, its back stepping through it', must: /<BottlePicker\s+\{\.\.\.pickerBack\.pickerProps\}/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/check-in/rate.tsx', label: 'app check-in create: the picked link on the wire', must: /\.\.\.linkBody\(draft\.choice\)/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/edit/details.tsx', label: 'app check-in edit: the bottle picker, its back stepping through it', must: /<BottlePicker\s+\{\.\.\.pickerBack\.pickerProps\}/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/edit/[id].tsx', label: 'app check-in edit: a re-link on the wire', must: /\.\.\.\(m\.choice \? linkBody\(m\.choice\) : \{\}\)/ },
  // The screen's back steps through the picker first (ruled 2026-11-22): a
  // save's own back must not be caught as a step back, and only a BACK is.
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'app add impression: a save leaves past the picker\'s back', must: /pickerBack\.allowLeave\(\);\s*router\.back\(\);/ },
  { file: 'apps/mobile/src/app/(tabs)/feed/edit/details.tsx', label: 'app check-in edit details: Done leaves past the picker\'s back', must: /pickerBack\.allowLeave\(\);\s*router\.back\(\);/ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: only a back steps back, only while in front', must: /usePreventRemove\(enabled && focused && can, [\s\S]{0,120}?if \(\(t === 'GO_BACK' \|\| t === 'POP'\) && ref\.current\) ref\.current\.stepBack\(\);\s*else repeat\(\);/ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: the NV tick chip beside the year', must: /<ChoiceChip tick label="NV" on=\{nv\} onPress=\{\(\) => onNv\(!nv\)\}/ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: the year field disabled while NV', must: /<TextField label="Year"[\s\S]{0,300}?editable=\{!nv\}/ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: the NV info popover beside the chip', must: /<NvInfo \/>[\s\S]*Non-vintage: a release without a year\./ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: the picked wine\'s year read through the NV chip', must: /pickedChoice\(product, vintages, nv, yearText, abvText\)/ },
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: the new wine\'s year read through the NV chip', must: /newWineChoice\(\{ producer, name: wineQ, colour, sparkling, nv, year: yearText,/ },
  // Step 7b review: the new wine's name is its own state, never the wine search's
  // text (typing it there sent a catalogue search on every pause).
  { file: 'apps/mobile/src/components/catalog/BottlePicker.tsx', label: 'app picker: a new wine\'s name field sends no search', must: /<TextField label="Wine" placeholder="Its name" value=\{wineQ\} onChangeText=\{setWineQ\}/ },
  { file: 'apps/mobile/src/lib/catalogChoice.ts', label: 'app choice: NV ticked → year: null', must: /if \(nv\) return \{ ok: true, year: null \};/ },
  { file: 'apps/mobile/src/lib/catalogChoice.ts', label: 'app choice: the typed year canonicalized', must: /const v = normalizeVintageText\(t\);/ },
  { file: 'apps/mobile/src/lib/catalogChoice.ts', label: 'app choice: the added year sends the resolved year as is', must: /body: \{ productId: product\.id, year: f\.year,/ },
  { file: 'apps/mobile/src/lib/catalogChoice.ts', label: 'app choice: the new wine sends the resolved year as is', must: /\.\.\.\('year' in y \? \{ year: y\.year \} : \{\}\)/ },
  // The bottle's own fields keep the tested add-vs-edit split (1b).
  { file: 'apps/mobile/src/app/(tabs)/moments/session/[code]/add.tsx', label: 'session add/edit: payload builder', must: /buildImpressionPayload\(/ },
  // The web (catalogue model change step 4): a bottle's year is the catalogue
  // entry's, chosen from the vintage lookup or typed in the picker for a new
  // wine / a missing year, where it is canonicalized before it becomes the
  // add flow's `year` (NV → null, four digits → the year).
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the typed year canonicalized', must: /const v = normalizeVintageText\(raw\.trim\(\)\)/ },
  // The label scanner seeds the picker's search; its year is canonicalized
  // where it enters the prefill.
  { file: 'components/wine/AddWineModal.tsx', label: 'web label scanner: canonicalize extracted value', must: /year: gotVintage \? normalizeVintageText\(gotVintage\)/ },
  // 🔒 The NV control (ruled 2026-07-26; phase B with the model change, step
  // 6): a checkbox beside each year input of the picker. Ticking it clears and
  // disables the year input, and the add flow then gets a REAL `year: null`
  // (never a string the server parses). One resolver for both inputs.
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: NV ticked → year: null', must: /nvTicked \? \{ ok: true as const, year: null \}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the new wine\'s year read through the NV box', must: /const y = yearOf\(nv, yearText\)/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year read through the NV box', must: /const y = yearOf\(addNvOn, addYear\)/ },
  // The new wine's draft re-runs on the box (exhaustive-deps is off there:
  // without `nv` a tick on an empty year would send no year, "year unknown").
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the new wine\'s draft re-runs on the NV box', must: /\}, \[creating, producer, wineQ, kind, nv, yearText,/ },
  // The resolved year is what goes on the wire, as is (null = the NV row).
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the new wine sends the resolved year as is', must: /\{ year: y\.year \} : \{\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year sends the resolved year as is', must: /body: \{ productId: p\.id, year: y\.year,/ },
  // "add a year" offers NV only once the years are in and none is NV; a tick
  // from before they arrived counts for nothing (review r1: it stranded a
  // disabled input once an NV chip arrived and the box unmounted).
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year\'s NV box waits for the years', must: /const nvAddable = vintages !== null && !vintages\.some\(v => v\.year === null\)/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year\'s tick counts only while the box is offered', must: /const addNvOn = addNv && nvAddable/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year\'s notice names the NV box only while it is offered', must: /setNotice\(nvAddable \? 'Type a four-digit year, or tick NV\.' : 'Type a four-digit year\.'\)/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year\'s NV box rendered only while offered', must: /\{nvAddable && \(\s*<NvToggle checked=\{addNvOn\}/ },
  // The added year's tick never outlives its wine: cleared on reset, on a
  // picked wine and on the wine's "change".
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: reset clears the added year\'s NV box', must: /function reset\(\) \{[^}]*setAddNv\(false\)/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: a picked wine clears the added year\'s NV box', must: /setProduct\(p\); setAddNv\(false\)/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the wine\'s "change" clears the added year\'s NV box', must: /setProduct\(null\); setAddNv\(false\)/ },
  // The info popover: the (i)'s description while open, and it leaves with
  // the focus (else the next Escape is the popover's, not the sheet's).
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the NV popover describes the (i)', must: /aria-describedby=\{open \? noteId : undefined\}[\s\S]*id=\{noteId\} role="note"/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the NV popover closes when focus moves on', must: /onBlur=\{e => \{ if \(e\.relatedTarget && !e\.currentTarget\.contains\(e\.relatedTarget as Node\)\) setOpen\(false\) \}\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the new wine\'s NV box clears the year', must: /<NvToggle checked=\{nv\} onChange=\{v => \{ setNv\(v\); if \(v\) setYearText\(''\) \}\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year\'s NV box clears it', must: /<NvToggle checked=\{addNvOn\} onChange=\{v => \{ setAddNv\(v\); if \(v\) setAddYear\(''\) \}\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the new wine\'s year input disabled while NV', must: /value=\{yearText\}[\s\S]{0,200}?disabled=\{nv\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the added year input disabled while NV', must: /value=\{addYear\}[\s\S]{0,200}?disabled=\{addNvOn\}/ },
  // The box reports its tick (review, Codex pass: without the handler both
  // boxes are read-only and every other pin still holds).
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: the NV box is a checkbox that reports its tick', must: /<input type="checkbox" checked=\{checked\} onChange=\{e => onChange\(e\.target\.checked\)\}/ },
  { file: 'components/wine/CatalogPicker.tsx', label: 'web picker: a scanned NV ticks the box', must: /setNv\(prefill\.year === 'NV'\)/ },

  // Server persistence boundary — the authority. Since step 4 the bottle's
  // vintage text is never a body value: it is the snapshot of the linked
  // entry's year ('NV' for the non-vintage row, '' at product grain), and
  // the catalogue's own year is range-checked by validateYear at the mint.
  { file: 'lib/catalogEntries.ts', label: 'the snapshot\'s year text from the entry', must: /e\.year === null \? 'NV' : String\(e\.year\)/ },
]

for (const { file, label, must } of CALL_SITES) {
  const src = read(file)
  if (src === null) continue
  if (!must.test(src)) {
    problems.push(`${file}: MISSING call site — ${label}\n      expected to match: ${must}`)
  }
}

// (The catalog-link comparator and its no-stringify pin are RETIRED with the
// identity-edit rule, catalogue model change step 4: typed text never becomes
// the snapshot, so there is nothing to compare.)

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
      ['name', /name: scanText\(result\.name\)/, 'scanText'],
      ['producer', /producer: scanText\(result\.producer\)/, 'scanText'],
      ['grape', /grape: scanText\(result\.grape\)/, 'scanText'],
      ['type', /const gotType = scanText\(result\.type\)/, 'scanText'],
    ]
    for (const [field, re, helper] of SCAN_FIELDS) {
      if (!re.test(src)) {
        problems.push(`${f}: scanner field '${field}' is not ASSIGNED from ${helper}() (expected ${re}). A helper call whose result is discarded leaves local coercion live while the helper's own tests still pass.`)
      }
    }
    // The value that reaches the prefill must be the coerced one.
    if (!/year: gotVintage \? normalizeVintageText\(gotVintage\)/.test(src)) {
      problems.push(`${f}: the scanned vintage put into the prefill must be normalizeVintageText(gotVintage) — i.e. the value that came from scanVintage.`)
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
const CLIENT_ROOTS = ['components', 'app', 'apps/mobile/src']
// A web year INPUT (catalogue model change step 6): every web file with one
// must carry an NV box per input (phase B's acceptance scope: every surface
// with a year input, not one form), and each such input must be disable-able
// by it. Found by TRAITS, not by markup adjacency (review r1: a wrapper div
// between the label and the input hid both of the picker's own): an <input>
// or <select> whose label (the last `fl` label or <label> in the 400
// characters before it) or own aria-label / name / id names a year or a
// vintage, or one shaped like a year (a placeholder with "20XX", "YYYY" or a
// year, or a year-shaped min / max; not maxLength 4 alone, review r4: a
// 4-character code would fail loudly as a year). Checkboxes excepted. A
// <label>'s text is read up to its </label>, child tags dropped; a `=>` inside
// a <select>'s attributes doesn't end the tag (review r3). Comments are not
// code. A field component that hides its <input> elsewhere is out of reach:
// its own file is scanned instead.
function webYearInputs(raw) {
  const src = uncomment(raw)
  const out = []
  for (const m of src.matchAll(/<input\b[\s\S]*?\/>|<select\b(?:=>|[^>])*>/g)) {
    const tag = m[0]
    if (/type="checkbox"/.test(tag)) continue
    const win = src.slice(Math.max(0, m.index - 400), m.index)
    let label = ''
    for (const l of win.matchAll(/className="fl">([^<]*)<|<label\b(?:=>|[^>])*>/g)) label = l[1] ?? win.slice(l.index + l[0].length).split('</label>')[0].replace(/<[^>]*>/g, ' ')
    if (/year|vintage/i.test(label) || /(?:aria-label|name|id)=\{?["'`][^"'`]*(?:year|vintage)/i.test(tag) || /placeholder="[^"]*(?:20XX|YYYY|\b(?:19|20)\d\d\b)[^"]*"|\b(?:min|max)=\{?["']?(?:1[89]|2[01])\d\d\b/.test(tag)) out.push(tag)
  }
  return out
}
// An app year INPUT (step 7): a `<TextField>` / `<TextInput>` labelled or shaped like a year
// (label "Year" / "Vintage", placeholder "Year" / "20XX" / "YYYY", or an
// accessibility label naming one). Its box is the NV tick chip, and it must be
// disable-able by it (`editable={!…}`). The year field may then be digits-only:
// NV is the chip, not typed (the forbidden patterns below still guard a
// free-text vintage line).
function appYearInputs(raw) {
  const src = uncomment(raw)
  const out = []
  // A `TextField`, or a raw `TextInput` (review r1: a raw input was invisible).
  for (const m of src.matchAll(/<(?:TextField|TextInput)\b[\s\S]*?\/>/g)) {
    const tag = m[0]
    if (/label="(?:Year|Vintage)"|placeholder="(?:Year|20XX|YYYY)"|accessibilityLabel="[^"]*(?:year|vintage)/i.test(tag)) out.push(tag)
  }
  return out
}
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
    const app = file.startsWith('apps/')
    const yearInputs = app ? appYearInputs(src) : webYearInputs(src)
    const isInput = /setVintage\(/.test(src) || /label\s*=\s*["']Vintage["']/.test(src) || /className="fl">vintage/.test(src) || yearInputs.length > 0
    if (!isInput) continue
    // One box per year input, not one per file (review r2: a file-level
    // mention is not a call site). The app's box is the NV tick chip.
    const boxes = (uncomment(src).match(app ? /<ChoiceChip tick label="NV"/g : /<NvToggle /g) ?? []).length
    if (yearInputs.length > boxes) {
      problems.push(`${file}: ${yearInputs.length} year input(s) but ${boxes} NV box(es) (${app ? '<ChoiceChip tick label="NV">' : '<NvToggle>'}). Ruled 2026-07-26: a box beside every year field, sending a real year: null.`)
    }
    for (const input of yearInputs) {
      const disableable = app ? /editable=\{!/.test(input) : /disabled=\{(?!\s*false\s*\})/.test(input)
      if (!disableable) problems.push(`${file}: a year input the NV box cannot disable: ${input.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
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
