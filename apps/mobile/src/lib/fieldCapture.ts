import { createContext, useContext, useEffect, useId, useMemo } from 'react';

// A rating field reports when its native edit starts and when it ENDED, so the
// moment impression layer can wait for it before a departure takes the
// transition guard (lib/impressionLayerCore.ts `createInputCapture`, Codex
// recheck 2026-11-26). The page provides it (components/moments/ImpressionPage.tsx);
// without a provider (the check-in rate stage, every other form) it is a no-op.
//
// 🔒 The edit ENDS at `onEndEditing`, never at `onBlur` (Codex recheck 2,
// 2026-11-26): React Native emits both on every native end of editing, but in
// opposite orders (iOS `textInputDidEndEditing`: end-editing, then blur;
// Android's focus listener: blur, then end-editing), and only end-editing
// carries the FINAL text (`nativeEvent.text`, an IME / dictation commit
// included). So the field applies that text through its own setter FIRST and
// then reports the end (`fieldEndEditing`): exactly once per edit, the final
// value in, on both platforms. Blur stays the focus UI's. An unmount (no event
// comes) and the capture's bounded belt are the fallbacks.
export type FieldCaptureSink = { focus: (id: string) => void; done: (id: string) => void };
export const FieldCaptureContext = createContext<FieldCaptureSink | null>(null);

// The final text applied, then the end reported (also when applying throws).
export function fieldEndEditing(sink: FieldCaptureSink | null, id: string, apply: () => void) {
  try {
    apply();
  } finally {
    sink?.done(id);
  }
}

export function useFieldCapture(): { began: () => void; endEditing: (apply: () => void) => void } {
  const sink = useContext(FieldCaptureContext);
  const id = useId();
  // A field unmounted mid-edit sends no end-editing: it counts as ended.
  useEffect(() => () => sink?.done(id), [sink, id]);
  return useMemo(
    () => ({
      began: () => sink?.focus(id),
      endEditing: (apply: () => void) => fieldEndEditing(sink, id, apply),
    }),
    [sink, id],
  );
}
