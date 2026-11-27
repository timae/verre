import type { AromaSelection } from '@verre/core';
import type { CatalogChoice } from './catalogChoice';

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
  // The rate stage's Hide from Feed (Moment Defaults, plan § 3): preset from
  // your check-in default once it loads, then the switch's value, always sent
  // once shown (ruled 2026-11-25); undefined = never shown (the server applies
  // the default). Kept here so a frozen retry re-sends the same body.
  hiddenFromFeed?: boolean;
  // 🔒 A post is in flight or may have landed: Hide from Feed is final as sent
  // (a value, or nothing) until a definite refusal unlocks it, so a back-swipe
  // and a second rate stage can't change what a retry sends (Codex build r2).
  privacyLocked?: boolean;
  // A POST is in flight (from this or an earlier rate stage of the flow): a
  // second one waits for it (Codex build r3), so a refusal of the second can
  // never unlock the switch while the first may still land.
  posting?: boolean;
};

// Stage 1's "Rate It" rebuilds the draft from its own fields and KEEPS what
// the rate stage holds (a back-swipe to tweak a detail must not wipe the score,
// nor the Hide from Feed switch; a frozen post keeps its id and wine so a retry
// sends the same body). Pure (the root units pin it).
export type CheckinDetails = Pick<CheckinDraft, 'choice' | 'photo' | 'vinification' | 'description' | 'purchaseUrl' | 'venue' | 'city'>;
export function nextCheckinDraft(prev: CheckinDraft | null, details: CheckinDetails, occurrenceId: string): CheckinDraft {
  return {
    ...details,
    occurrenceId: prev?.occurrenceId ?? occurrenceId,
    choice: prev?.frozen ? prev.choice : details.choice,
    frozen: !!prev?.frozen,
    photoTried: !!prev?.photoTried,
    score: prev?.score ?? 0,
    flavors: prev?.flavors ?? {},
    aromas: prev?.aromas ?? [],
    notes: prev?.notes ?? '',
    hiddenFromFeed: prev?.hiddenFromFeed,
    privacyLocked: prev?.privacyLocked,
    posting: prev?.posting,
  };
}

// Keyed by the TAB the flow runs on (lists plan D8): the Feed's pill and your
// Impressions' "+ Check In" (the You stack) are separate flows, so a Feed draft
// and a You draft never overwrite each other. (The pills never show on an
// opened post's stack.)
const drafts = new Map<string, CheckinDraft>();
// Subscribable (Codex build r5): a rate stage re-renders when ANOTHER stage of
// the flow changes the draft (its lock, a post settling).
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version += 1; listeners.forEach((l) => l()); };
export function subscribeCheckinDrafts(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const checkinDraftVersion = (): number => version;

export function setCheckinDraft(tab: string, d: CheckinDraft) {
  drafts.set(tab, d);
  notify();
}

export function getCheckinDraft(tab: string): CheckinDraft | null {
  return drafts.get(tab) ?? null;
}

export function clearCheckinDraft(tab: string) {
  if (drafts.delete(tab)) notify();
}
