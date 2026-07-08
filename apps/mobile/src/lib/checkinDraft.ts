import type { WineTypeCode } from '@/lib/api/sessions';

// Ephemeral hand-off between the two check-in create stages (details →
// rate), same module-level pattern as lib/feedTransition.ts: the details
// screen writes the draft when it pushes the rate stage; the rate stage
// reads it at mount and builds the POST body from it + its own rating
// state. Nothing persists — a successful check-in (or leaving the flow)
// clears it. The photo data URL is far too big for route params, which is
// why this isn't param-passing.
//
// score/flavors/notes live here too so a back-swipe to the details stage
// and a second "Rate It" push restores the rating in progress (the rate
// screen writes them back on unmount).

export type CheckinDraft = {
  photo: { dataUrl: string; previewUri: string } | null;
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
  score: number;
  flavors: Record<string, number>;
  notes: string;
};

let draft: CheckinDraft | null = null;

export function setCheckinDraft(d: CheckinDraft) {
  draft = d;
}

export function getCheckinDraft(): CheckinDraft | null {
  return draft;
}

export function clearCheckinDraft() {
  draft = null;
}
