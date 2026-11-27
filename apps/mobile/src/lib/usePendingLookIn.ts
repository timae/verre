import { router, useNavigationContainerRef } from 'expo-router';
import { useEffect, useReducer, useRef } from 'react';
import { Alert } from 'react-native';
import { closeFullscreenViewers, useFullscreenViewerOpen } from './fullscreenViewer';
import { consumePendingLookIn, hasPendingLookIn, pendingLookInKind, setLookInOpenerActive, subscribeLookInLinks } from './lookInLinks';
import { openerDecision, tabsStateKey, type NavState } from './lookInOpener';
import { lookHref } from './sessionStack';

// Opens a look-in that arrived by LINK (Moment Visibility step-2 plan § 4.3).
// Rendered ONCE, by the tabs layout, as its own component (PendingLookInOpener:
// its re-renders on navigation-state events stay out of the tabs layout,
// review r1). It runs only while signed in and past the username screen, so a
// link that arrives signed out waits through sign-in (R13), within its 15
// minutes (lib/lookInLinks.ts). The decision (wait / switch to Moments / push
// on the focused stack) is lib/lookInOpener.ts; it is re-taken on every
// navigation-state change, every new link, the photo viewer closing, and every
// 500 ms while a link is pending (a cold start may decide before the navigator
// has its state, review r1). A bad link alerts at once, at most every 10 s.
const BAD_LINK_ALERT_GAP_MS = 10_000;

export function usePendingLookIn(): void {
  const nav = useNavigationContainerRef();
  const viewerOpen = useFullscreenViewerOpen();
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const lastBadAlert = useRef(0);
  useEffect(() => {
    setLookInOpenerActive(true);
    const off = subscribeLookInLinks(bump);
    return () => { off(); setLookInOpenerActive(false); };
  }, []);
  // Only while a link is pending: otherwise nothing here re-renders.
  useEffect(() => nav.addListener('state', () => { if (hasPendingLookIn()) bump(); }), [nav]);
  useEffect(() => {
    if (!hasPendingLookIn()) return;
    const t = setInterval(bump, 500);
    return () => clearInterval(t);
  }, [tick]);
  useEffect(() => {
    if (!hasPendingLookIn()) return;
    if (pendingLookInKind() === 'bad') {
      consumePendingLookIn();
      const now = Date.now();
      if (now - lastBadAlert.current < BAD_LINK_ALERT_GAP_MS) return;
      lastBadAlert.current = now;
      Alert.alert('This link doesn’t work');
      return;
    }
    const decision = openerDecision(nav.getRootState() as NavState | undefined, viewerOpen);
    if (decision.kind === 'wait') return;
    // The viewer closes through its own close (the gallery lands on its page);
    // `viewerOpen` turning false runs this again.
    if (decision.kind === 'close-viewer') { closeFullscreenViewers(); return; }
    if (decision.kind === 'switch-to-moments') {
      // A plain tab switch (JUMP_TO on the tabs navigator): Moments keeps its
      // stack as it is (a href navigation could pop it to its home).
      const target = tabsStateKey(nav.getRootState() as NavState | undefined);
      if (target) nav.dispatch({ type: 'JUMP_TO', payload: { name: 'moments' }, target });
      return;
    }
    const opening = consumePendingLookIn();
    if (opening?.kind !== 'link') return;
    router.push(lookHref(decision.mount, '', { momentId: opening.momentId, via: 'link', h: opening.handle }));
  }, [tick, viewerOpen, nav]);
}

// The tabs layout renders this (nothing visible).
export function PendingLookInOpener(): null {
  usePendingLookIn();
  return null;
}
