// Coercion for values arriving from an UNTRUSTED, untyped source — currently
// the wine-label scanner's model-generated JSON (`components/wine/AddWineModal.tsx`).
//
// 🔒 THIS IS PRODUCTION CODE, IMPORTED BY THE COMPONENT. An earlier cut declared
// the parsed JSON as string-valued and asserted its shape; the compiler could not
// catch the lie, and a conventional `"vintage": 2019` reached the normalizer as a
// number and threw on `.trim()`, failing the entire scan. A later cut fixed the
// component with a LOCAL helper and tested a COPY of it in the suite — so
// mutating production to accept floats left both the suite and the wiring gate
// green. Extracting it here is what makes the tests test the shipped behaviour.
//
// The type split is deliberate and asymmetric:
//   • VINTAGE accepts a string OR an integer. A model answering "the 4-digit
//     year" with a JSON number is a legitimate reading of the prompt, and
//     discarding it would throw away what the label actually said.
//   • TEXT fields (name, producer, grape, type) accept STRINGS ONLY. A numeric
//     producer or grape is not a plausible reading of a label — it is a
//     malformed response, and coercing it would launder junk into the form.

// A textual label field. Strings only — see the asymmetry note above.
export function scanText(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// The vintage field. A string passes through; a numeric value is rendered to
// text so the shared `normalizeVintageText` can canonicalize it.
//
// 🔒 A NUMBER MUST ALREADY BE A PLAUSIBLE 4-DIGIT YEAR — exactly four decimal
// digits, 1000..9999. Accepting "any safe integer" was not enough: -2019
// stringified to "-2019", and the normalizer's digit-extraction then stripped
// the sign and stored "2019". A malformed negative year became a valid one.
// (The normalizer now rejects a leading sign too — belt and braces, because a
// direct client never passes through here.) Rejects 0, 999, 10000, -2019.
//
// 🔒 Rejects floats (2019.5 is not a year) and non-finite values, and never
// throws: the scan path treats a bad field as "not extracted", not as an error.
export function scanVintage(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return null
  // Four decimal digits only. This is a SHAPE check, matching the normalizer's
  // structural grammar — neither layer applies plausibility BOUNDS, which live
  // at catalog promotion (`validateYear`). The 1000..9999 test here exists to
  // reject a SIGNED or wrong-width number before it reaches the normalizer,
  // where digit handling would otherwise have laundered '-2019' into '2019'.
  return v >= 1000 && v <= 9999 ? String(v) : null
}
