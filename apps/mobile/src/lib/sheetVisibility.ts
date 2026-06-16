import { useSyncExternalStore } from 'react';

// Tracks whether ANY bottom sheet is currently open, so the OS tab bar
// (NativeTabs in (tabs)/_layout.tsx) can hide while a sheet is up. We hide the
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

// Blind "Reveal mode" on the line-up (02b) hides the OS tab bar the same way a
// sheet does — the design replaces the nav with a sticky "Done" footer while
// the host reveals/hides impressions. Reveal mode is screen STATE (not a route,
// so the pathname-keyed `hidden` list in (tabs)/_layout can't catch it) and not
// a sheet (so it doesn't belong on the sheet count). A separate ref-counted
// flag keeps the two reasons independent; the tab layout ORs both.
let revealModeCount = 0;

export function pushRevealMode() {
  revealModeCount += 1;
  emit();
}

export function popRevealMode() {
  revealModeCount = Math.max(0, revealModeCount - 1);
  emit();
}

// True when the OS tab bar should hide for an in-screen reason the route path
// can't express (a sheet up, or blind Reveal mode active).
export function useTabBarOverlayHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => count > 0 || revealModeCount > 0,
    () => false,
  );
}
