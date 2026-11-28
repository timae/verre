import type { RefObject } from 'react';
import type { ViewInstance } from 'react-native';

// A toolbar search's focus (the line-up's and Compare's, 0.2.0 build 2): the
// toolbar's top in the window, measured when asked (null when it can't be), so
// the screen can scroll it up to where it pins, above the keyboard.
export type MeasureTop = () => Promise<number | null>;
export function measureTopOf(ref: RefObject<ViewInstance | null>): MeasureTop {
  return () => new Promise((resolve) => {
    const node = ref.current;
    if (!node) return resolve(null);
    const t = setTimeout(() => resolve(null), 120);
    node.measureInWindow((_x, y, _w, h) => { clearTimeout(t); resolve(h > 0 ? y : null); });
  });
}
