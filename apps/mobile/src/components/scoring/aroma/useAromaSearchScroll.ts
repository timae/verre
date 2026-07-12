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
) {
  const { height: screenH } = useWindowDimensions();
  const keyboardHRef = useRef(300);
  useEffect(() => {
    const subs = [
      Keyboard.addListener('keyboardWillShow', (e) => { keyboardHRef.current = e.endCoordinates.height; }),
      Keyboard.addListener('keyboardDidShow', (e) => { keyboardHRef.current = e.endCoordinates.height; }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return (rowTopInWindow: number, blockBelow: number) => {
    const visibleBottom = screenH - keyboardHRef.current - 8;
    const delta = rowTopInWindow + blockBelow - visibleBottom;
    if (delta > 4) scrollRef.current?.scrollTo({ y: scrollYRef.current + delta, animated: true });
  };
}
