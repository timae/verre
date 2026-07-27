// ── ATTRIBUTIONS_PATH runtime-override pins ────────────────────────────────
//
// The override REPLACES the entry list wholesale. That makes it a hole straight
// through every invariant the CI parity gate enforces, because the gate can
// only see the two in-repo copies — never a file supplied at runtime.
//
// The failure that motivated these pins: a file containing one valid new source
// would silently DELETE X-Wines, LWIN, BC Liquor and Open Brewery DB. Dropping a
// required attribution is the precise breach this surface exists to prevent.
//
// Every case below drives the REAL getAttributions() against a real temp file.
// Run: npx tsx scripts/tests/attributions-override-units.ts

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAttributions, resetAttributionsCache, type AttributionEntry } from '../../lib/attributions'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'attr-override-'))
const file = join(dir, 'attributions.json')

// The bundled list, read once with no override in play — this is both the
// fallback we expect on rejection and the source of the mandatory set.
delete process.env.ATTRIBUTIONS_PATH
resetAttributionsCache()
const BUNDLED = getAttributions()
const BUNDLED_SOURCES = BUNDLED.map((e) => e.source).sort()

// Load `entries` as an override and return what getAttributions() actually
// resolves to. Cache reset each time so every case is independent.
function loadOverride(entries: unknown): AttributionEntry[] {
  writeFileSync(file, JSON.stringify(entries), 'utf8')
  process.env.ATTRIBUTIONS_PATH = file
  resetAttributionsCache()
  return getAttributions()
}
// ⚠️ COMPARE THE WHOLE PAYLOAD, NOT THE SOURCE NAMES. Every rejection case
// below starts from a clone of the bundled list and mutates ONE field, so the
// source names are identical whether the override was rejected or wrongly
// accepted — a name-only comparison passes in both cases and pins nothing.
// (First version of this helper did exactly that: disabling the validator
// produced ZERO failures.) Deep-equality against the bundled list is what
// actually distinguishes "fell back" from "accepted the bad data".
const fellBack = (got: AttributionEntry[]) =>
  JSON.stringify(got) === JSON.stringify(BUNDLED)

// A deep clone of the bundled list is the VALID baseline every rejection case
// mutates — so each test differs from a known-good override by exactly one
// thing, and a rejection can only be caused by that thing.
const valid = () => JSON.parse(JSON.stringify(BUNDLED)) as AttributionEntry[]

console.log('\n§1 a valid override is accepted')
{
  const o = valid()
  o.push({
    id: 'example-source',
    source: 'Example Source',
    sourceUrl: 'https://example.org/data',
    licence: { spdx: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', text: '' },
    attribution: '',
    verified: true,
    notes: 'Added in a test override.',
  })
  const got = loadOverride(o)
  check(
    'a complete, valid override REPLACES the bundled list',
    got.length === BUNDLED.length + 1 && got.some((e) => e.source === 'Example Source'),
    `got ${got.length} entries`,
  )
}

console.log('\n§2 every invariant violation falls back ATOMICALLY to the bundled list')

// 🔒 THE MOTIVATING CASE. One valid entry is still a valid ENTRY — it is the
// missing mandatory sources that must reject it.
{
  const got = loadOverride([
    {
      id: 'example-source',
      source: 'Example Source',
      sourceUrl: 'https://example.org/data',
      licence: { spdx: 'MIT', url: 'https://example.org/licence', text: 'x' },
      attribution: 'y',
      verified: true,
      notes: 'Structurally valid, but drops every mandatory source.',
    },
  ])
  check(
    'a one-entry override does NOT delete the mandatory sources',
    fellBack(got),
    `got sources: ${got.map((e) => e.source).join(', ')}`,
  )
}

{
  const o = valid().filter((e) => e.licence.spdx !== 'MIT')
  const got = loadOverride(o)
  check('omitting a single mandatory source is rejected', fellBack(got), `got ${got.length} entries`)
}

{
  const o = valid()
  o.push(JSON.parse(JSON.stringify(o[0])))
  const got = loadOverride(o)
  check('a duplicate id is rejected', fellBack(got), `got ${got.length} entries`)
}

{
  const o = valid()
  o[0].verified = false
  const got = loadOverride(o)
  check('verified:false is rejected', fellBack(got) && got[0].verified === true)
}

{
  const o = valid()
  o[0].notes = '   '
  const got = loadOverride(o)
  check('blank notes are rejected', fellBack(got) && got[0].notes.trim().length > 0)
}

// 🔒 These render as tappable links on both surfaces, so a non-http scheme
// would be a scheme-injection vector on a page every user is invited to open.
for (const [label, bad] of [
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>1</script>'],
  ['file:', 'file:///etc/passwd'],
] as const) {
  {
    const o = valid()
    o[0].sourceUrl = bad
    check(`sourceUrl with ${label} is rejected`, fellBack(loadOverride(o)))
  }
  {
    const o = valid()
    o[0].licence.url = bad
    check(`licence.url with ${label} is rejected`, fellBack(loadOverride(o)))
  }
}

{
  const got = loadOverride([])
  check('an empty list is rejected', fellBack(got), `got ${got.length} entries`)
}

{
  writeFileSync(file, '{not json', 'utf8')
  process.env.ATTRIBUTIONS_PATH = file
  resetAttributionsCache()
  check('malformed JSON is rejected', fellBack(getAttributions()))
}

{
  process.env.ATTRIBUTIONS_PATH = join(dir, 'does-not-exist.json')
  resetAttributionsCache()
  check('an unreadable path is rejected', fellBack(getAttributions()))
}

{
  const o = valid() as unknown[]
  delete (o[0] as Record<string, unknown>).licence
  const got = loadOverride(o)
  check('a schema violation (missing licence) is rejected', fellBack(got))
}

console.log('\n§2b IDENTITY is the immutable `id`, not the display name')

// 🔒 THE CONTRACT THIS EXISTS FOR: an ops override must be able to CORRECT a
// source's displayed legal name. Keying identity on the display name made a
// rename indistinguishable from a deletion, so the override was rejected as
// "missing a mandatory source" — which meant the documented ability to correct
// a source through deploy config did not actually exist.
{
  const o = valid()
  o[0].source = 'X-Wines (corrected legal name)'
  const got = loadOverride(o)
  check(
    'the SAME mandatory id with a corrected display name is ACCEPTED',
    !fellBack(got) && got[0].source === 'X-Wines (corrected legal name)' && got[0].id === o[0].id,
    `got source="${got[0].source}" (fellBack=${fellBack(got)})`,
  )
}

{
  const o = valid()
  o.push({ ...JSON.parse(JSON.stringify(o[0])), source: 'A different display name' })
  const got = loadOverride(o)
  check('a duplicate id under a DIFFERENT display name is rejected', fellBack(got))
}

{
  // Reusing a mandatory DISPLAY NAME under a different id must not satisfy
  // presence — otherwise the mandatory check is defeated by a rename.
  const o = valid()
  o[0].id = 'not-the-mandatory-id'
  const got = loadOverride(o)
  check(
    'reusing a mandatory display name under a DIFFERENT id does not satisfy presence',
    fellBack(got),
    'The dropped id must be reported missing even though its display name is still present.',
  )
}

{
  const o = valid() as unknown as Array<Record<string, unknown>>
  o[0].id = 'Not Kebab Case'
  const got = loadOverride(o)
  check('a non-kebab-case id is rejected by the schema', fellBack(got))
}

console.log('\n§3 the mandatory set is DERIVED, not hardcoded')
check(
  'every bundled source is treated as mandatory',
  BUNDLED.length >= 4 && BUNDLED.every((e) => /^[a-z0-9-]+$/.test(e.id)) &&
    new Set(BUNDLED.map((e) => e.id)).size === BUNDLED.length,
  `bundled ids: ${BUNDLED.map((e) => e.id).join(', ')}`,
)

rmSync(dir, { recursive: true, force: true })
delete process.env.ATTRIBUTIONS_PATH
resetAttributionsCache()

console.log(
  failures === 0
    ? `\nOK — attributions override pins all pass.`
    : `\nFAILED — ${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
