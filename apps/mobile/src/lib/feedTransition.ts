// One-shot handoff of the tapped feed card's photo frame to the impression
// detail's shared-element open (proposal 09). A module store, not router
// params: the payload is measured floats + a uri, and it must never leak into
// the URL (a deep link with a stale frame would animate from garbage).
//
// Protocol: the card MEASURES its photo frame and calls setFeedTransitionSource
// right before pushing the detail route; the detail CONSUMES it once on mount.
// kind 'photo' drives the hero-clone grow/shrink; kind 'fade' (no photo to
// share — NonPhotoHero, blind, placeholder slide) asks for the plain fade/rise
// presentation. A missing/stale entry means "no transition" (cold deep link).

export type FeedTransitionSource =
  | { kind: 'photo'; x: number; y: number; width: number; height: number; uri: string }
  | { kind: 'fade' };

let pending: { source: FeedTransitionSource; at: number } | null = null;

// Fresh-only window: if the push never mounted a detail (race, nav failure),
// the stale frame must not animate some LATER unrelated open.
const FRESH_MS = 1500;

export function setFeedTransitionSource(source: FeedTransitionSource) {
  pending = { source, at: Date.now() };
}

export function consumeFeedTransitionSource(): FeedTransitionSource | null {
  const p = pending;
  pending = null;
  if (!p || Date.now() - p.at > FRESH_MS) return null;
  return p.source;
}
