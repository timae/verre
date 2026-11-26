import { createContext, useContext, useEffect, useId, useMemo } from 'react';

// A rating field reports when its native edit starts and when it ENDED (its
// blur / end-editing event, the last keystrokes and an IME commit already in),
// so the moment impression layer can wait for it before a departure takes the
// transition guard (lib/impressionLayerCore.ts `createInputCapture`, Codex
// recheck 2026-11-26). The page provides it (components/moments/ImpressionPage.tsx);
// without a provider (the check-in rate stage, every other form) it is a no-op.
export type FieldCaptureSink = { focus: (id: string) => void; done: (id: string) => void };
export const FieldCaptureContext = createContext<FieldCaptureSink | null>(null);

export function useFieldCapture(): { began: () => void; ended: () => void } {
  const sink = useContext(FieldCaptureContext);
  const id = useId();
  // A field unmounted mid-edit sends no blur: it counts as ended.
  useEffect(() => () => sink?.done(id), [sink, id]);
  return useMemo(
    () => ({
      began: () => sink?.focus(id),
      ended: () => sink?.done(id),
    }),
    [sink, id],
  );
}
