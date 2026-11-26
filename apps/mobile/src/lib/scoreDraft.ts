import { SCORE_MAX, snapScore } from '@verre/core';

// The score number's typed text → a score (components/scoring/ScoreInput.tsx).
// ONE conversion for the live keystrokes AND the field's final native text at
// end-editing (Codex recheck 3, 2026-11-26): an erased or unreadable number is
// 0 (not rated) in both, so a deletion that only the end-editing event carries
// is applied before a departure drains (lib/fieldCapture.ts).

// Sanitize a raw keystroke string into a left-anchored decimal the user is
// typing: keep digits + a single separator, cap the integer part at one digit
// (scores are 0..5), and cap to two fraction digits. NO reformatting to a fixed
// X.XX — that fought the caret and made the field flicker on every keystroke.
// "2" stays "2"; "2.5" stays "2.5"; "25" (no dot) is read as 2.5 by parseScoreDraft.
export function sanitizeScoreDraft(text: string) {
  let s = text.replace(/[^0-9.,]/g, '').replace(',', '.');
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const intPart = s.slice(0, dot).slice(0, 1);
    const fracPart = s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    s = `${intPart}.${fracPart}`;
  } else {
    // No separator yet: a lone "25" means 2.5 — keep first digit as units, the
    // rest flow into the fraction so the bar can track digit-by-digit.
    if (s.length > 1) s = `${s.slice(0, 1)}.${s.slice(1, 3)}`;
  }
  return s;
}

// Parse a sanitized draft to a raw 0..5 number (pre-snap); null = nothing readable.
export function parseScoreDraft(text: string): number | null {
  if (!text || text === '.') return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return Math.min(SCORE_MAX, Math.max(0, n));
}

// The score a typed text means: snapped to the 0.25 grid, 0 when erased or
// unreadable. The live change and the end-editing both use it.
export function scoreFromDraft(text: string): number {
  const parsed = parseScoreDraft(sanitizeScoreDraft(text));
  return parsed == null ? 0 : snapScore(parsed);
}

// What the end of an edit writes: nothing when the slider took over while the
// field was open (`abandoned`: the typed draft is dropped, the slider's value
// wins) or when the final text means the current value; else that score.
export function endEditScore(text: string, abandoned: boolean, current: number): number | null {
  if (abandoned) return null;
  const next = scoreFromDraft(text);
  return next === current ? null : next;
}
