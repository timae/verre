// 🔒 The add-vs-edit payload split for a bottle's OWN fields, extracted so it
// can be TESTED rather than asserted-by-grep.
//
// Since the catalogue model change a bottle's identity (name, producer, year,
// kind, grapes, origin) is its catalogue wine (lib/catalogChoice.ts, ADR-0009);
// what the bottle keeps of its own is About (`description`), Process
// (`vinification`) and the purchase link. The session impression form
// (`moments/session/[code]/add.tsx`) serves BOTH modes, and they need
// DIFFERENT shapes:
//
//   • ADD — omitting an empty field is correct. There is nothing to clear,
//     and sending `''` would store an empty string where NULL is meant.
//   • EDIT — omission means "unchanged" to the server, so a field the user
//     CLEARED would silently keep its old value. An edit sends every field
//     explicitly, empty string included.
//
// ⚠️ This module is the ONLY place that decides the shape.
// `scripts/check-vintage-wiring.mjs` asserts the component CALLS this, and the
// unit suite pins the behaviour.

export type ImpressionFields = {
  vinification: string;
  description: string;
  purchaseUrl: string;
};

export const OPTIONAL_IMPRESSION_FIELDS = ['vinification', 'description', 'purchaseUrl'] as const;

export type ImpressionPayload = Partial<Record<(typeof OPTIONAL_IMPRESSION_FIELDS)[number], string>>;

export function buildImpressionPayload(fields: ImpressionFields, mode: 'add' | 'edit'): ImpressionPayload {
  const isEdit = mode === 'edit';
  const out: ImpressionPayload = {};
  for (const key of OPTIONAL_IMPRESSION_FIELDS) {
    const value = fields[key].trim();
    // EDIT: always present, so a cleared field actually clears.
    // ADD: omitted when empty.
    if (isEdit || value) out[key] = value;
  }
  return out;
}
