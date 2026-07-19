import type { WineTypeCode } from '@/lib/api/sessions';

// Module store carrying a standalone check-in EDIT between the edit screen
// and its pushed details sub-screen (the checkinDraft pattern — a photo data
// URL is far too big for route params). Seeded by the edit screen from the
// cached CheckinPayload; the details screen mutates it; the edit screen reads
// it back on focus and at save time.
export type CheckinEditMeta = {
  feedItemId: number;
  name: string;
  vintage: string;
  producer: string;
  type: WineTypeCode | null;
  grape: string;
  wineRegion: string;
  wineCountry: string; // ISO-2, '' = unset
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
