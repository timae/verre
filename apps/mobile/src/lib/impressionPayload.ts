import { normalizeVintageText } from '@verre/core';

// 🔒 The add-vs-edit payload split, extracted so it can be TESTED rather than
// asserted-by-grep.
//
// The session impression form (`moments/session/[code]/add.tsx`) serves BOTH
// modes. The two need DIFFERENT payload shapes, and conflating them was a real
// bug:
//
//   • ADD — omitting an empty optional field is correct. There is nothing to
//     clear, and sending `''` would store an empty string where NULL is meant.
//   • EDIT — omission means "unchanged" to the server, so a field the user
//     CLEARED silently keeps its old value. For `vintage` it was worse than a
//     no-op: `applyIdentityEditRule` reads the omission as unchanged and KEEPS
//     the catalog link, while the wine write stores the empty value anyway —
//     leaving a blank vintage still linked to a vintage-grain catalog row.
//
// So an edit sends every editable field explicitly, empty string included.
//
// ⚠️ This module is the ONLY place that decides the shape. A component that
// re-derives it inline (`vintage: cleanVintage || undefined`) reintroduces the
// bug while leaving a "the helper exists" gate green — which is exactly the
// bypass review found. `scripts/check-vintage-wiring.mjs` asserts the component
// CALLS this, and the unit suite pins the behaviour.

export type ImpressionFields<T extends string = string> = {
  name: string;
  type: T;
  producer: string;
  vintage: string;
  grape: string;
  region: string;
  country: string;
  vinification: string;
  description: string;
  purchaseUrl: string;
};

// Every optional field, so "the whole class is fixed" is a tested claim rather
// than a vintage-shaped one. `name` and `type` are required and always sent.
export const OPTIONAL_IMPRESSION_FIELDS = [
  'producer',
  'vintage',
  'grape',
  'region',
  'country',
  'vinification',
  'description',
  'purchaseUrl',
] as const;

export type ImpressionPayload<T extends string = string> = {
  name: string;
  type: T;
} & Partial<Record<(typeof OPTIONAL_IMPRESSION_FIELDS)[number], string>>;

export function buildImpressionPayload<T extends string>(
  fields: ImpressionFields<T>,
  mode: 'add' | 'edit',
): ImpressionPayload<T> {
  const isEdit = mode === 'edit';
  // Canonicalize, don't trim: the per-keystroke filter lets an NV-token PREFIX
  // through, so a half-typed 'non-vinta' must never reach the server.
  const vintage = normalizeVintageText(fields.vintage);
  const trimmed: Record<string, string> = {
    producer: fields.producer.trim(),
    vintage,
    grape: fields.grape.trim(),
    // `country` is an ISO-2 code chosen from a picker, never free text — it is
    // already canonical, so it is not trimmed, only included/omitted.
    country: fields.country,
    region: fields.region.trim(),
    vinification: fields.vinification.trim(),
    description: fields.description.trim(),
    purchaseUrl: fields.purchaseUrl.trim(),
  };
  const out: ImpressionPayload<T> = { name: fields.name.trim(), type: fields.type };
  for (const key of OPTIONAL_IMPRESSION_FIELDS) {
    const value = trimmed[key];
    // EDIT: always present, so a cleared field actually clears.
    // ADD: omitted when empty.
    if (isEdit || value) out[key] = value;
  }
  return out;
}
