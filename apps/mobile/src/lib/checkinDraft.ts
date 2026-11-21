import type { AromaSelection } from '@verre/core';
import type { CatalogChoice } from '@/lib/catalogChoice';

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
  // The flow's client id (lib/clientId.ts): a retry answers the same check-in.
  occurrenceId: string;
  // The catalogue wine (ADR-0009): a pick, or a new wine added with the post.
  choice: CatalogChoice;
  // 🔒 A post MAY have landed (the freeze rule): the details stage shows the
  // choice read-only, so a retry never sends an edited `create`.
  frozen: boolean;
  photo: { dataUrl: string; previewUri: string } | null;
  // A photo upload was tried for this check-in: a photo cleared since must be
  // removed on the server too (the upload may have landed without its answer).
  photoTried?: boolean;
  vinification: string;
  description: string;
  purchaseUrl: string;
  venue: string;
  city: string;
  score: number;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  notes: string;
};

// Keyed by the TAB the flow runs on (lists plan D8): the Feed's pill and your
// Impressions' "+ Check In" (the You stack) are separate flows, so a Feed draft
// and a You draft never overwrite each other. (The pills never show on an
// opened post's stack.)
const drafts = new Map<string, CheckinDraft>();

export function setCheckinDraft(tab: string, d: CheckinDraft) {
  drafts.set(tab, d);
}

export function getCheckinDraft(tab: string): CheckinDraft | null {
  return drafts.get(tab) ?? null;
}

export function clearCheckinDraft(tab: string) {
  drafts.delete(tab);
}
