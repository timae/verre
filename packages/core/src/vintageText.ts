// The free-text vintage field (`wines.vintage`, Char(4)) accepts a 4-digit
// year OR the literal non-vintage token. Shared web↔native so a client cannot
// destroy what a label actually said.
//
// 🔒 This is a DISPLAY-STRING rule, not the catalog's identity rule. The
// catalog represents the non-vintage bottling as `wine_vintages.year = null`
// (see lib/catalogWrite.ts validateYear); no client can produce that today.
// Recognizing "NV" here only keeps the string intact so the later backfill —
// which resolves this same token to the NV row — has something to read.
//
// 🔒 The allowlist is a case-insensitive EXACT match, deliberately not a
// substring or prefix test: "NV Selection" is a wine name, not a non-vintage
// marker. Spelling is kept identical to the backfill rule in
// docs/dev/proposals/wine-catalog.md § "Token handling" — the two must agree,
// or a token a client accepts is one the backfill files as garbage.
const NV_TOKENS = ['nv', 'n.v.', 'nv.', 'non-vintage']

// The canonical form stored in the Char(4) column. "non-vintage" does not fit
// in 4 characters, so every recognized token normalizes to this.
export const NV_DISPLAY = 'NV'

export function isNonVintageToken(raw: string): boolean {
  return NV_TOKENS.includes(raw.trim().toLowerCase())
}

// Coerce free text (typed or label-scanned) into what the column can hold:
// the NV token, a 4-digit year, or empty. Anything else is dropped rather
// than mangled — a partial digit-strip is what turned a scanned "NV" into a
// blank field.
//
// ⚠️ NOT for a per-keystroke handler. This is a BOUNDARY normalizer (scan
// result, blur, submit): it maps every unrecognized string to a year-or-empty,
// so running it on each keystroke makes NV unreachable — "n" is not yet a
// token, normalizes to "", and the field can never accumulate the second
// character. Use `filterVintageInput` while typing.
export function normalizeVintageText(raw: string): string {
  const trimmed = raw.trim()
  if (isNonVintageToken(trimmed)) return NV_DISPLAY
  // 🔒 A NARROW GRAMMAR, NOT DIGIT EXTRACTION.
  //
  // The rule is an EXACT four-digit year after trimming, optionally preceded by
  // an approximation marker ("c. 2019"). Everything else is empty. Partial
  // years, overlong years, ranges, signed forms, and whitespace-separated
  // digits are all REJECTED.
  //
  // ⚠️ This replaced a blanket `replace(/\D/g, '')`, which was a LOSSY REPAIR
  // machine rather than a validator. Measured consequences, each a value the
  // user never typed:
  //   '2019-2020' → '2019'  (fabricated precision from a range)
  //   '-2019'     → '2019'  (sign silently laundered away)
  //   '20 19'     → '2019'  (digits joined across whitespace)
  //   '2019er'    → '2019'  (unit/suffix discarded)
  // The extraction also made 'c. 2019' work by ACCIDENT, not by design — so the
  // approximation form is now explicit, and everything else that extraction
  // used to "rescue" now correctly lands empty. Under-claiming is the intended
  // failure direction: an unusable value belongs at product grain, where a
  // human can promote it, rather than becoming a confident wrong year.
  const match = trimmed.match(/^(?:c\.?|ca\.?|circa)?\s*([0-9]{4})$/i)
  if (!match) return ''
  // 🔒 THE GRAMMAR IS STRUCTURAL; PLAUSIBILITY BOUNDS DELIBERATELY LIVE
  // ELSEWHERE. A 1800..current+1 range was added here and REVERTED: this
  // function runs on every edit RESEND, so bounding it silently BLANKED an
  // existing out-of-range value the moment a user touched any other field on the
  // form. Measured — a stored '1780' resent unchanged normalized to '', and
  // `applyIdentityEditRule` then compared ''-vs-'' as UNCHANGED and KEPT the
  // catalog link: a blank vintage still linked at vintage grain, the third
  // instance of that defect class on this branch. A write-boundary validator
  // cannot retroactively invalidate stored data without an initial-value-aware
  // edit path on every surface.
  //
  // So: exactly four digits (or an NV token) is the shape rule, and range
  // plausibility is enforced only where a value becomes SHARED identity —
  // `validateYear` at catalog promotion (1900..current+1). That also matches the
  // agreed backfill promotion rule: out-of-range legacy values are PRESERVED as
  // encounter strings and default to product grain, never auto-minted.
  return match[1]
}

// The per-keystroke filter: keeps the field from accepting junk without
// blocking the path to a valid token. Digits are capped at 4; a prefix of any
// NV token is allowed through so the user can actually finish typing it.
// Canonicalize with `normalizeVintageText` at the boundary.
export function filterVintageInput(raw: string): string {
  const capped = raw.slice(0, 11) // longest token, 'non-vintage'
  const lower = capped.trim().toLowerCase()
  if (lower && NV_TOKENS.some(t => t.startsWith(lower))) return capped
  return capped.replace(/\D/g, '').slice(0, 4)
}
