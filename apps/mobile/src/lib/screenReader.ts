import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Whether a screen reader (VoiceOver / TalkBack) is on, live. Long lists and
// row carousels detach off-screen rows (removeClippedSubviews) only while it is
// off: a detached row leaves the accessibility tree, so swiping through a list
// would stop at the last attached row (apps/mobile/CLAUDE.md, long lists).
let enabled = false;
const listeners = new Set<() => void>();
const update = (on: boolean) => {
  if (on === enabled) return;
  enabled = on;
  listeners.forEach((l) => l());
};
AccessibilityInfo.isScreenReaderEnabled().then(update, () => {});
AccessibilityInfo.addEventListener('screenReaderChanged', update);
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useScreenReaderEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}
