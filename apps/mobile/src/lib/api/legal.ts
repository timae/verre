import { apiFetch } from '@/lib/apiFetch';

// Corpus-level legal attributions for the wine catalog.
//
// 🔒 This is a LICENCE OBLIGATION surface, not credits. See lib/attributions.ts
// on the server for the full rationale; the rules that reach the client are:
//   • BOTH links MUST be rendered as followable links, each labelled for what
//     it is: `licence.url` (the compliance-relevant one — CC BY requires "a
//     link to the license", OGL-BC requires a link to the licence) and
//     `sourceUrl` (where the dataset lives). They are separate fields because
//     conflating them left LWIN linking a dataset page instead of its licence.
//   • `licence.text` renders VERBATIM — no trim, no re-wrap, no normalisation.
//     Reproduce the OGL-BC en dash (U+2013) exactly as received.
//   • `verified: false` MUST render its caveat visibly.
//
// ── Why there is a bundled fallback ────────────────────────────────────────
//
// The entries are DEPLOY CONFIG on the server so that adding a source is an ops
// change rather than an app release. A native binary cannot read server env, so
// the app FETCHES them — but a legal surface that renders blank offline is worse
// than one rendering a known-good snapshot. Hence: fetch first, fall back to the
// snapshot below.
//
// 🔒 THE COST OF THE FALLBACK IS STALENESS, AND STALENESS MUST BE VISIBLE.
// Two copies of legal text can disagree, and the stale one would otherwise show
// outdated terms with no tell. So `origin: 'bundled'` is returned alongside the
// entries and the screen MUST surface it. Do not "simplify" that away.

export type AttributionEntry = {
  // 🔒 IMMUTABLE MACHINE IDENTITY — never rendered. Parity, uniqueness and
  // mandatory-presence checks key on this, never on the mutable `source`
  // display name (which an ops override is allowed to correct).
  id: string;
  source: string;
  // Where the SOURCE lives. 🔒 NOT the licence link — see licence.url.
  sourceUrl: string;
  // 🔒 `licence.url` is the compliance-relevant link: CC BY requires "provide a
  // link to the license" and OGL-BC requires a link to the licence. Render it.
  licence: { spdx: string; url: string; text: string };
  attribution: string;
  verified: boolean;
  notes: string;
  dataPeriod?: string;
};

export type AttributionsResult = {
  entries: AttributionEntry[];
  // 'live'    — fetched from the server this session.
  // 'bundled' — the snapshot below; the screen shows a staleness notice.
  origin: 'live' | 'bundled';
};

// ── Bundled snapshot ───────────────────────────────────────────────────────
//
// ⚠️ MIRRORS lib/attributions.ts DEFAULT_ENTRIES. When that file changes, change
// this too — they are two copies by design (see above), and a CI gate asserts
// they agree (scripts/check-attributions-parity.mjs).
//
// 🔒 The MIT block is reproduced byte-for-byte from the Open Brewery DB LICENSE.
// 🔒 The OGL-BC statement contains U+2013 EN DASH, not a hyphen.
export const BUNDLED_ATTRIBUTIONS: AttributionEntry[] = [
  {
    id: "x-wines",
    source: "X-Wines",
    sourceUrl: "https://github.com/rogerioxavier/X-Wines",
    licence: {
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      text: '',
    },
    attribution: "",
    verified: true,
    notes: "CC0 1.0 confirmed firsthand; the dataset ships its own LICENSE file. Attribution is not required — the paper citation is a courtesy, not an obligation. The licence link is the canonical CC0 deed URL (creativecommons.org blocks automated requests from our build environment, so it was not fetch-verified from here).",
  },
  {
    id: "lwin",
    source: "LWIN (Liv-ex)",
    sourceUrl: "https://www.liv-ex.com/lwin/",
    licence: {
      spdx: "CC-BY-4.0",
      url: "https://www.liv-ex.com/lwin-creative-commons-licence/",
      text: '',
    },
    attribution: "Contains LWIN data © Liv-ex Ltd, used under CC BY 4.0. Modified: records have been normalized, deduplicated and merged with other sources.",
    verified: true,
    notes: "Statement supplied verbatim and confirmed firsthand. The modification notice is required because our pipeline normalizes, deduplicates and merges the records.",
  },
  {
    id: "bc-liquor",
    source: "BC Liquor Store product data",
    sourceUrl: "https://catalogue.data.gov.bc.ca/dataset/bc-liquor-store-product-price-list-current-prices",
    licence: {
      spdx: "OGL-BC-2.0",
      url: "https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc",
      text: '',
    },
    attribution: "Contains information licensed under the Open Government Licence – British Columbia.",
    verified: true,
    notes: "Read firsthand from www2.gov.bc.ca on 2026-07-26; licence version 2.0. The en dash (U+2013) in the statement is verified by codepoint and must be reproduced exactly. Known gap: OGL-BC binds to the licence version in force as of the date the data was accessed. That access instant was not measured, but retrieval is bounded between 2026-07-15 (BC’s own resource last_modified) and 2026-07-24 (our repo capture) — a window narrow enough that a licence-version change inside it is implausible rather than unknown.",
    dataPeriod: "April 2026",
  },
  {
    id: "open-brewery-db",
    source: "Open Brewery DB",
    sourceUrl: "https://www.openbrewerydb.org/",
    licence: {
      spdx: "MIT",
      url: "https://github.com/openbrewerydb/openbrewerydb/blob/master/LICENSE",
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
    attribution: "Contains data from Open Brewery DB, © 2025 Open Brewery DB, used under the MIT License.",
    verified: true,
    notes: "Full MIT text read firsthand from the project LICENSE file on 2026-07-26. This is the strictest obligation on this page — the complete notice must be reproduced, which is why licence.text carries the whole block.",
  },
];

// Shape-check a wire entry before trusting it. A malformed server response must
// fall back to the snapshot rather than render a half-empty legal page.
function isEntry(v: unknown): v is AttributionEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  const lic = e.licence as Record<string, unknown> | undefined;
  return (
    typeof e.id === 'string' && e.id.length > 0 &&
    typeof e.source === 'string' && e.source.length > 0 &&
    typeof e.sourceUrl === 'string' && e.sourceUrl.length > 0 &&
    // 🔒 `licence.url` is validated because it is the link the licence
    // REQUIRES. An entry without it must not be treated as usable.
    !!lic && typeof lic.spdx === 'string' && typeof lic.text === 'string' &&
    typeof lic.url === 'string' && lic.url.length > 0 &&
    typeof e.attribution === 'string' &&
    typeof e.verified === 'boolean' &&
    typeof e.notes === 'string'
  );
}

// 🔒 NEVER THROWS and never returns an empty list — a legal surface must always
// render something. Any failure (offline, timeout, bad shape) resolves to the
// bundled snapshot with `origin: 'bundled'` so the screen can say so.
export async function fetchAttributions(): Promise<AttributionsResult> {
  try {
    const res = await apiFetch('/api/legal/attributions');
    if (!res.ok) return { entries: BUNDLED_ATTRIBUTIONS, origin: 'bundled' };
    const body = (await res.json()) as { entries?: unknown };
    const list = body?.entries;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isEntry)) {
      return { entries: BUNDLED_ATTRIBUTIONS, origin: 'bundled' };
    }
    return { entries: list, origin: 'live' };
  } catch {
    return { entries: BUNDLED_ATTRIBUTIONS, origin: 'bundled' };
  }
}
