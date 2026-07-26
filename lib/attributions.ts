import { readFileSync } from 'node:fs'
import { z } from 'zod'

// ── attributions: the corpus-level legal attribution surface ────────────────
//
// 🔒 THIS IS A LICENCE OBLIGATION, NOT A COURTESY. Several sources the wine
// catalog draws on legally require naming the source (CC BY, OGL-BC, MIT), so
// shipping catalog data without rendering these entries is a licence breach.
// That is why the attributions surface is a hard release gate on the FIRST
// CATALOG FILL rather than a phase-4 nicety.
//
// 🔒 ATTRIBUTION IS CORPUS-LEVEL, NEVER PER-RECORD. Naming the sources on this
// surface satisfies the licences. Attaching a source id / URL / slug to an
// individual catalog row does NOT satisfy them and is separately forbidden
// (wine-catalog.md § Data-provenance rule). Nothing here joins back to a row,
// and nothing may be added that does.
//
// ── Why a file and not env vars ────────────────────────────────────────────
//
// The requirement is that adding or changing a source be an OPS CHANGE, not an
// app release — licence terms change independently of our deploy cycle. A file
// read at runtime satisfies that: point ATTRIBUTIONS_PATH at a mounted config
// file and the surface changes with no rebuild.
//
// It is deliberately NOT env-var-embedded. `licence.text` is a multi-line
// verbatim legal block (the MIT notice is 1072 bytes with hard newlines);
// round-tripping that through shell quoting is exactly the kind of fragility
// that silently corrupts a string we are legally required to reproduce
// EXACTLY. A JSON file keeps the bytes intact and reviewable.
//
// The bundled DEFAULT_ENTRIES below ship in the repo so the surface is never
// blank — a legal page that fails open to "nothing to show" is worse than a
// stale one. ATTRIBUTIONS_PATH overrides them wholesale when set.
//
// 🔒 `licence.text` IS A `scrub()` CARVE-OUT — RENDER IT VERBATIM.
// Do NOT run it through lib/textSafe.ts `scrub`, and do NOT trim it. The house
// rule "apply scrub to every free-text field" (lib/CLAUDE.md) is about
// UNTRUSTED REQUEST BODIES; this is trusted, operator-supplied legal text and
// the rule does not apply. Measured against the real implementation:
//   • scrub PRESERVES the OGL-BC en dash (U+2013 sits below SCRUB_RE's range),
//     so that string would survive — but see the en-dash note below anyway.
//   • scrub does NOT preserve the MIT block: it `.trim()`s, dropping the
//     trailing newline. Immaterial to the MIT text's meaning, but it proves
//     scrub is the wrong tool here, and it is the tool someone WILL reach for.
// The carve-out is stated explicitly because the default otherwise wins.
//
// 🔒 REPRODUCE THE OGL-BC EN DASH EXACTLY (U+2013, not a hyphen).
// Verified firsthand against www2.gov.bc.ca on 2026-07-26: the REQUIRED
// attribution statement uses an EN DASH — "Open Government Licence – British
// Columbia" — while the same page's own TITLE uses an ASCII hyphen. Both forms
// appear in one document. Any well-meaning punctuation normalisation would
// alter a legally required string. Never normalise this field.

// An entry describes the CORPUS contribution of one upstream source.
//
// Field-by-field, and why each exists (the originally-recorded shape was
// `{ source, licence, url }`, which two independent constraints broke):
//
//  • licence.text — MIT requires its permission notice reproduced VERBATIM,
//    so this cannot be a one-line string. It is a text BLOCK. `spdx` carries
//    the machine-readable identifier alongside it.
//  • verified    — an entry must be able to say its wording is UNVERIFIED, or
//    a best-guess paraphrase silently becomes the record. Machine-readable so
//    CI can assert "no unverified entry ships"; prose cannot be asserted on.
//  • notes       — the human WHY behind `verified`. "Unverified" alone cannot
//    distinguish "nobody looked" from "unreachable, here is the evidence".
//  • dataPeriod  — how stale the DATA is, which is what a reader actually
//    wants to know. Deliberately NOT an access/retrieval date: our stored
//    timestamps resolve to repo-capture (a git-add date, identical across all
//    inputs because they were committed together) and would assert something
//    nobody measured.
const EntrySchema = z.object({
  // Display name of the upstream source.
  source: z.string().min(1),
  // Where the SOURCE lives — the dataset's own home page.
  //
  // 🔒 THIS IS NOT THE LICENCE LINK. The two are different things and were
  // originally conflated in one `url` field, which meant the LWIN entry's only
  // clickable link pointed at a general dataset page while CC BY explicitly
  // requires a link to THE LICENCE. Keep them separate.
  sourceUrl: z.string().url(),
  licence: z.object({
    // SPDX identifier where one exists ('CC0-1.0', 'CC-BY-4.0', 'MIT').
    // OGL-BC has no SPDX id; it carries its descriptive name instead.
    spdx: z.string().min(1),
    // 🔒 THE LICENCE ITSELF, AND IT MUST BE RENDERED AS A REAL LINK.
    // CC BY 4.0 requires "provide a link to the license"; OGL-BC requires
    // "where possible, provide a link to this licence". Holding the URL in
    // config without rendering it does not satisfy either.
    url: z.string().url(),
    // 🔒 VERBATIM. Never scrubbed, never trimmed, never normalised.
    // Empty string is legitimate: CC0 waives attribution, so there is no
    // notice we are obliged to reproduce.
    text: z.string(),
  }),
  // The attribution statement we are obliged to display, verbatim where the
  // licence specifies one. Empty when none is required (CC0).
  attribution: z.string(),
  // Has this wording been confirmed against the PRIMARY source firsthand?
  // 🔒 A false value MUST render its caveat VISIBLY on both surfaces.
  verified: z.boolean(),
  // Why `verified` holds the value it does. Always present, both states.
  notes: z.string(),
  // Optional: the period the DATA covers, when known and meaningful.
  dataPeriod: z.string().optional(),
})

export type AttributionEntry = z.infer<typeof EntrySchema>

const EntriesSchema = z.array(EntrySchema)

// ── The bundled entries ────────────────────────────────────────────────────
//
// 🔒 DO NOT TRIM THIS LIST BY "WHICH SOURCES ACTUALLY CONTRIBUTED ROWS".
// A source can contribute FACTS via enrichment while contributing no rows of
// its own, and the obligation attaches to use of the data, not to row count.
// Note that the STRICTEST obligation here (MIT, which requires the full notice
// reproduced) belongs to the source with the LEAST data. Removing an entry
// because it "looks unused" is how a breach happens.
const DEFAULT_ENTRIES: AttributionEntry[] = [
  {
    source: 'X-Wines',
    sourceUrl: 'https://github.com/rogerioxavier/X-Wines',
    licence: {
      spdx: 'CC0-1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      // CC0 is a public-domain dedication: there is no notice we are required
      // to reproduce, so this is deliberately empty rather than a paraphrase.
      text: '',
    },
    // CC0 WAIVES attribution. Citing the dataset paper is academic courtesy,
    // not a licence condition — so nothing is asserted as required here.
    attribution: '',
    verified: true,
    notes: 'CC0 1.0 confirmed firsthand; the dataset ships its own LICENSE file. Attribution is not required — the paper citation is a courtesy, not an obligation. The licence link is the canonical CC0 deed URL (creativecommons.org blocks automated requests from our build environment, so it was not fetch-verified from here).',
  },
  {
    source: 'LWIN (Liv-ex)',
    sourceUrl: 'https://www.liv-ex.com/lwin/',
    licence: {
      spdx: 'CC-BY-4.0',
      // 🔒 Liv-ex's own LWIN licence page, which names CC BY 4.0 and links the
      // legal code. Verified firsthand 2026-07-26. NOT the general /lwin/
      // material page — that is the source, not the licence, and CC BY
      // requires a link to THE LICENCE.
      url: 'https://www.liv-ex.com/lwin-creative-commons-licence/',
      // CC BY 4.0's legal code is canonical at creativecommons.org and is not
      // reproduced here; what we are obliged to RENDER is the attribution
      // statement below, carrying the TASL elements + the modification notice.
      text: '',
    },
    // 🔒 THE MODIFICATION NOTICE IS NOT OPTIONAL under CC BY 4.0 — we
    // normalize, deduplicate and merge these records with other sources, so
    // "changes were made" is a fact about our use and must be stated.
    // Verbatim as supplied.
    attribution: 'Contains LWIN data © Liv-ex Ltd, used under CC BY 4.0. Modified: records have been normalized, deduplicated and merged with other sources.',
    verified: true,
    notes: 'Statement supplied verbatim and confirmed firsthand. The modification notice is required because our pipeline normalizes, deduplicates and merges the records.',
  },
  {
    source: 'BC Liquor Store product data',
    sourceUrl: 'https://catalogue.data.gov.bc.ca/dataset/bc-liquor-store-product-price-list-current-prices',
    licence: {
      spdx: 'OGL-BC-2.0',
      // The licence text itself, read firsthand 2026-07-26.
      url: 'https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc',
      text: '',
    },
    // 🔒 EN DASH (U+2013) — NOT a hyphen. Read firsthand from the BC
    // government page on 2026-07-26. The page's own title uses an ASCII
    // hyphen; the REQUIRED statement uses an en dash. Do not normalise.
    attribution: 'Contains information licensed under the Open Government Licence – British Columbia.',
    verified: true,
    notes: 'Read firsthand from www2.gov.bc.ca on 2026-07-26; licence version 2.0. The en dash (U+2013) in the statement is verified by codepoint and must be reproduced exactly. Known gap: OGL-BC binds to the licence version in force as of the date the data was accessed. That access instant was not measured, but retrieval is bounded between 2026-07-15 (BC’s own resource last_modified) and 2026-07-24 (our repo capture) — a window narrow enough that a licence-version change inside it is implausible rather than unknown.',
    // The user-meaningful staleness signal: BC issues monthly price lists.
    //
    // Confirmed AT SOURCE by the data side (2026-07-26), not inferred from a
    // filename: BC's own resource is named
    // BC_Liquor_Store_Product_Price_List_April_2026, our copy is byte-identical
    // to what BC serves today (same size, same sha256), and BC is still
    // publishing that edition. So this is the current edition, not a stale hold.
    dataPeriod: 'April 2026',
  },
  {
    source: 'Open Brewery DB',
    sourceUrl: 'https://www.openbrewerydb.org/',
    licence: {
      spdx: 'MIT',
      // Supplementary only — MIT is satisfied by reproducing the notice, which
      // `text` below does in full. The link is a convenience, not the
      // compliance mechanism (unlike CC BY / OGL-BC, where it IS required).
      url: 'https://github.com/openbrewerydb/openbrewerydb/blob/master/LICENSE',
      // 🔒 VERBATIM MIT NOTICE — the strictest obligation on this page.
      // MIT requires "the above copyright notice and this permission notice"
      // be included in all copies or substantial portions. Fetched firsthand
      // from the project's LICENSE file on 2026-07-26 (1072 bytes, ASCII,
      // LF-only). Do not reflow, re-wrap, re-case, or trim this block.
      text: `MIT License

Copyright (c) 2025 Open Brewery DB

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
    },
    attribution: 'Contains data from Open Brewery DB, © 2025 Open Brewery DB, used under the MIT License.',
    verified: true,
    notes: 'Full MIT text read firsthand from the project LICENSE file on 2026-07-26. This is the strictest obligation on this page — the complete notice must be reproduced, which is why licence.text carries the whole block.',
  },
]

// Cached after the first successful load. The file is deploy-time config and
// does not change under a running process; re-reading it per request would be
// a filesystem hit on every page view for a value that cannot have changed.
let cached: AttributionEntry[] | null = null

// Resolve the attribution entries.
//
// Falls back to DEFAULT_ENTRIES when ATTRIBUTIONS_PATH is unset, unreadable, or
// fails validation. 🔒 THE FALLBACK IS DELIBERATE AND MUST NOT BECOME A THROW:
// this is a legal surface, and failing closed renders a blank page that breaches
// the very licences it exists to satisfy. A bad override is loud in the logs and
// invisible to the reader, which is the correct trade for this specific page.
export function getAttributions(): AttributionEntry[] {
  if (cached) return cached
  const path = process.env.ATTRIBUTIONS_PATH
  if (!path) {
    cached = DEFAULT_ENTRIES
    return cached
  }
  try {
    const parsed = EntriesSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    // An override that parses to an empty list is a misconfiguration, not an
    // instruction to render nothing — treat it like any other bad override.
    if (parsed.length === 0) throw new Error('ATTRIBUTIONS_PATH resolved to an empty list')
    cached = parsed
    return cached
  } catch (err) {
    console.error(`[attributions] failed to load ATTRIBUTIONS_PATH=${path}, falling back to bundled entries:`, err)
    cached = DEFAULT_ENTRIES
    return cached
  }
}

// Test seam: drop the cache so a test can exercise a different override.
// Not called by application code.
export function resetAttributionsCache(): void {
  cached = null
}
