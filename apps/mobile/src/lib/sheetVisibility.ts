import { useSyncExternalStore } from 'react';

// Tracks whether ANY bottom sheet is currently open, so the pill tab bar
// (PillTabBar via (tabs)/_layout.tsx) can hide while a sheet is up. We hide the
// bar rather than rendering the sheet in a react-native-screens FullWindowOverlay
// (the obvious "above the tab bar" trick): under @gorhom/bottom-sheet v5 the
// overlay threads a SECOND, full-window container height into the sheet that
// competes with the per-screen provider's measured height — the sheet then sizes
// to one space and parks against the other (a bottom gap + a collapsed-to-sliver
// dynamic-sized pane), and it traps anything presented from inside the sheet
// (OS share sheet, row menus) behind the overlay window. Hiding the bar instead
// lets every sheet render in-screen at correct coordinates.
//
// Ref-COUNTED, not a boolean: two sheets can briefly overlap (e.g. People's "Add"
// closes People and opens Invite), and the count must not drop to 0 in the gap.
// Clamped at 0 so a stray pop can't strand the bar hidden.
let count = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function pushSheet() {
  count += 1;
  emit();
}

export function popSheet() {
  count = Math.max(0, count - 1);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAnySheetOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => count > 0,
    () => false,
  );
}

// True when the tab bar should hide for an in-screen reason the route path
// can't express (a sheet up). Blind Reveal MODE — the second counter that
// used to feed this — was removed with the mode itself (ADR-0007: the photo
// is the reveal control now, no footer replaces the nav).
export function useTabBarOverlayHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => count > 0,
    () => false,
  );
}
