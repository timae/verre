import { useNavigation } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

// Whether a fullscreen photo viewer (ui/FullscreenImage, feed/FullscreenGallery)
// is open. The root Stack reads it to hide the status bar as a SCREEN TRAIT
// (`statusBarHidden` on its screenOptions): the viewers present their Modal
// overFullScreen (see FullscreenImage for why), and under that presentation
// UIKit never asks the modal's controller for the status bar — the presenting
// chain answers, and react-native-screens answers from traits only (a JS
// <StatusBar hidden> is never consulted on iOS). Which screen's trait counts
// depends on the host: a transparentModal host (the feed's impression detail)
// is skipped by the RNS trait walk, so only the ROOT screen's trait reaches
// UIKit — that is this store; a fullScreenModal host (the feed edit details
// were one until 2026-11-24) is asked directly by UIKit, so the hook ALSO sets the trait on the viewer's
// nearest screen — imperatively, with a cleanup that restores it, because a
// <Stack.Screen> element leaves its options behind when it unmounts (a host
// that drops the photo while the viewer is open would strand the bar hidden,
// Codex 2026-11-06). A counter, not a boolean: two viewers never overlap
// today, but a close racing an open must not un-hide the bar under the one
// still showing.
let openCount = 0;
const listeners = new Set<() => void>();
// The open viewers' own close (a look-in link closes them first, lib/lookInOpener.ts).
const closers = new Set<() => void>();
export function closeFullscreenViewers() {
  [...closers].forEach((close) => close());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit() {
  listeners.forEach((l) => l());
}

export function useFullscreenViewerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openCount > 0, () => false);
}

type ViewerScreenOptions = { statusBarHidden: boolean; statusBarAnimation?: 'fade' };

// Called by a viewer with its open state (and its own close); while open the
// root AND the nearest screen carry the hide, both released on close or
// unmount, and `close` is what closeFullscreenViewers calls.
export function useReportFullscreenViewer(open: boolean, close?: () => void) {
  const navigation = useNavigation<{ setOptions: (options: ViewerScreenOptions) => void }>();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    openCount += 1;
    const closer = () => closeRef.current?.();
    closers.add(closer);
    emit();
    navigation.setOptions({ statusBarHidden: true, statusBarAnimation: 'fade' });
    return () => {
      openCount -= 1;
      closers.delete(closer);
      emit();
      navigation.setOptions({ statusBarHidden: false });
    };
  }, [open, navigation]);
}
