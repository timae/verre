import type { BottleLabel, CatalogChoice } from '@/lib/catalogChoice';

// Module store carrying a standalone check-in EDIT between the edit screen
// and its pushed details sub-screen (the checkinDraft pattern — a photo data
// URL is far too big for route params). Seeded by the edit screen from the
// cached CheckinPayload; the details screen mutates it; the edit screen reads
// it back on focus and at save time.
export type CheckinEditMeta = {
  feedItemId: number;
  // The bottle as it is (the catalogue wine's label, ADR-0009).
  label: BottleLabel;
  // A re-link picked on the details screen (a pick or a new wine); null = the
  // bottle keeps its wine (the PATCH sends no link).
  choice: CatalogChoice | null;
  vinification: string;
  description: string;
  purchaseUrl: string;
  venue: string;
  city: string;
  /** The photo edit state: `undefined` = unchanged (render existingImageUrl),
      a picked object = replacement, `null` = removed. */
  photo: { dataUrl: string; previewUri: string } | null | undefined;
  existingImageUrl: string | null;
};

let meta: CheckinEditMeta | null = null;

export function setCheckinEditMeta(m: CheckinEditMeta) {
  meta = m;
}
export function getCheckinEditMeta(): CheckinEditMeta | null {
  return meta;
}
export function clearCheckinEditMeta() {
  meta = null;
}
