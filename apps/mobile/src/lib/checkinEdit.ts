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

// One entry PER EDIT SCREEN, keyed by the edit's own key (`newCheckinEditKey`,
// passed to its details screen as `edit`): since 2026-11-24 an edit is an
// ordinary push, so a look-in link (and from there another post's edit) can
// open on top of it, and a single slot let the second edit's close wipe the
// first's details or hand them to it (review 2026-11-24).
const metas = new Map<string, CheckinEditMeta>();
export function newCheckinEditKey(feedItemId: number): string {
  return `${feedItemId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
export function setCheckinEditMeta(key: string, m: CheckinEditMeta) {
  metas.set(key, m);
}
export function getCheckinEditMeta(key: string | null | undefined): CheckinEditMeta | null {
  return key ? metas.get(key) ?? null : null;
}
export function clearCheckinEditMeta(key: string) {
  metas.delete(key);
}
