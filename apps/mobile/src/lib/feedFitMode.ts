import { useSyncExternalStore } from 'react';

// DEV-ONLY toggle for the feed photo fit mode, comparing the two approaches
// to a photo that doesn't match the carousel frame (proposal 08, Simon's
// crop-vs-bars question):
//   'bars' — CONTAIN + tint letterbox bars (nothing cropped).
//   'crop' — COVER (fill the frame, cropping the overflow; no bars).
// Lives in an external store (mirrors lib/sheetVisibility.ts) so the dev
// gallery can flip it live and every SessionFeedCard re-renders. Once Simon
// picks a mode, we hardcode the winner and delete this store + the toggle.

export type FeedFitMode = 'bars' | 'crop';

// Defaults to 'crop' — Simon's preference (2026-07). The toggle stays so
// bars can still be compared; once it's final we hardcode crop + delete this.
let mode: FeedFitMode = 'crop';
const listeners = new Set<() => void>();

export function setFeedFitMode(next: FeedFitMode) {
  if (mode === next) return;
  mode = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useFeedFitMode(): FeedFitMode {
  return useSyncExternalStore(
    subscribe,
    () => mode,
    () => mode,
  );
}
