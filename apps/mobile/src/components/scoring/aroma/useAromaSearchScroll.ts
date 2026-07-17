import { useEffect, useRef, type RefObject } from 'react';
import { Keyboard, useWindowDimensions, type ScrollView } from 'react-native';

// The screen-side half of AromaInput's keyboard fit — ONE implementation for
// every screen that hosts the input (session impression + standalone check-in
// rate stage), so the scroll math can't drift per screen.
//
// AromaInput calls onRequestScroll(rowTopInWindow, blockBelow) when its search
// field focuses (and again when the block's rendered height changes); this
// hook answers with the MINIMAL shift that fits the block above the keyboard
// — not a jump to the top of the screen (Simon's ask). The OS keyboard-inset
// alone only bottom-aligns the field itself; the block below it needs this.
// Keyboard height is captured from the show events (defaults to a mid-size
// board for the first pre-show call; the input's late re-measure corrects it).
//
// The caller owns the ScrollView ref and must keep `scrollYRef.current` at the
// live scroll offset (its onScroll handler — screens often track it anyway).
export function useAromaSearchScroll(
  scrollRef: RefObject<ScrollView | null>,
  scrollYRef: RefObject<number>,
  /** Height a floating footer (Save & Next bar) covers at the window bottom —
      the fit target is above WHICHEVER covers more, keyboard or footer (the
      canvas arm-nudge landed the Add row under the bar; Simon 2026-07-17).
      Screens pass their scroll-clearance constant: bar + breathing. */
  bottomObstruction = 0,
) {
  const { height: screenH } = useWindowDimensions();
  // 0 while the keyboard is CLOSED (it also serves the canvas arm-nudge,
  // which fits the Add row above the plain screen bottom — a stale board
  // height there over-scrolled). A pre-show focus call may under-scroll for
  // one beat; willShow + the input's late re-measure correct it.
  const keyboardHRef = useRef(0);
  useEffect(() => {
    const subs = [
      Keyboard.addListener('keyboardWillShow', (e) => { keyboardHRef.current = e.endCoordinates.height; }),
      Keyboard.addListener('keyboardDidShow', (e) => { keyboardHRef.current = e.endCoordinates.height; }),
      Keyboard.addListener('keyboardWillHide', () => { keyboardHRef.current = 0; }),
      Keyboard.addListener('keyboardDidHide', () => { keyboardHRef.current = 0; }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return (rowTopInWindow: number, blockBelow: number) => {
    const visibleBottom = screenH - Math.max(keyboardHRef.current, bottomObstruction) - 8;
    const delta = rowTopInWindow + blockBelow - visibleBottom;
    if (delta > 4) scrollRef.current?.scrollTo({ y: scrollYRef.current + delta, animated: true });
  };
}
