import { useCallback, useRef } from 'react';

// One small per-screen double-tap guard for pushes (People rows, counts, in
// common, View Profile, Join). People / profile chains must keep their
// history (A → B → A), so they can't use `dangerouslySingular`; a second tap
// within the window is swallowed instead (the opened post's card pushes use
// the same 700 ms).
export function usePushGuard(ms = 700): (push: () => void) => void {
  const last = useRef(0);
  return useCallback(
    (push: () => void) => {
      const now = Date.now();
      if (now - last.current < ms) return;
      last.current = now;
      push();
    },
    [ms],
  );
}
