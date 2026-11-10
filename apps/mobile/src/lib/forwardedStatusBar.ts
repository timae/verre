import { useIsFocused } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { useSessionTab } from '@/lib/sessionStack';

// The status-bar style of a screen inside an OPENED POST's own stack.
// On iOS the style is a screen trait (root _layout), and react-native-screens'
// trait walk stops at a presented screen (`findChildVCForConfigAndTrait`,
// includingModals:NO): the opened post is a transparentModal, so nothing on its
// nested stack is ever asked — the ROOT Stack's trait answers while it is up.
// A photo-hero screen pushed there (a moment's cover line-up, a moment
// impression) therefore forwards its style here, and the root Stack applies it
// (`statusBarStyle` in _layout.tsx), the same channel as lib/fullscreenViewer.
// Focus-scoped: only the FOCUSED screen forwards, so a pop (or a tab switch)
// hands the bar back on its own; a cancelled swipe keeps focus, so the style
// holds. Latest registration wins.
type Style = 'light' | 'dark';
const entries = new Map<number, Style>();
let seq = 0;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit() {
  listeners.forEach((l) => l());
}
function current(): Style | null {
  let last: Style | null = null;
  for (const v of entries.values()) last = v;
  return last;
}

// Root layout: the forwarded style, or null (the theme default applies).
export function useForwardedStatusBarStyle(): Style | null {
  return useSyncExternalStore(subscribe, current, () => null);
}

// A screen that sets its own `statusBarStyle` option calls this with the same
// value. A no-op unless the screen is mounted on an opened post's stack, where
// its own option is never consulted.
export function useForwardStatusBarStyle(style: Style) {
  const inPost = useSessionTab().post != null;
  const focused = useIsFocused();
  useEffect(() => {
    if (!inPost || !focused) return;
    const key = ++seq;
    entries.set(key, style);
    emit();
    return () => {
      entries.delete(key);
      emit();
    };
  }, [inPost, focused, style]);
}
