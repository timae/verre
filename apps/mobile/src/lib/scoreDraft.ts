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

// ONE edit session of the score number (focus → end-editing), pure so the
// units drive exactly what ScoreInput does (Codex rechecks 4 + 5, 2026-11-26):
// • UNTOUCHED is decided on the VALUE: an edit with no live change whose final
//   text means the score shown before the focus writes nothing (a score that
//   loaded while it was focused stays), whatever form the native text takes
//   (the focus seed "" / "4.5", or the pre-focus "0.00" / "4.50" when native
//   ends the edit before the seed reached it). The seed always means the shown
//   score (`value > 0 ? String(value) : ''`), so one comparison covers both. A
//   real erase of a rated score still writes 0, also when only end-editing
//   carries it;
// • every write (a keystroke, the end, the SLIDER) is deduped against
//   `current()`, the score in the draft NOW (the impression's autosave updates
//   it synchronously; the last rendered score lags a burst of events);
// • `abandon()`: the slider took over while the field was open: from then on
//   the edit's native text is ignored, a queued keystroke included, and its end
//   writes nothing (the slider's value wins).
export type ScoreEndResult = 'abandoned' | 'wrote' | 'none';
export function createScoreField(deps: { current: () => number; write: (v: number) => void }) {
  let edit: { shown: number; changed: boolean } | null = null;
  let abandoned = false;
  const writeIfNew = (next: number): boolean => {
    if (next === deps.current()) return false;
    deps.write(next);
    return true;
  };
  return {
    // onFocus, with the score the field showed before it.
    focus(shown: number) {
      edit = { shown, changed: false };
      abandoned = false;
    },
    // onChangeText: the live bar.
    change(text: string): boolean {
      if (abandoned) return false;
      if (edit) edit.changed = true;
      return writeIfNew(scoreFromDraft(text));
    },
    // The slider's pick (the same dedupe as the field's own writes).
    slide(next: number): boolean {
      return writeIfNew(next);
    },
    abandon() {
      abandoned = true;
    },
    // onEndEditing, with the FINAL native text.
    end(text: string): ScoreEndResult {
      const e = edit;
      edit = null;
      if (abandoned) {
        abandoned = false;
        return 'abandoned';
      }
      if (!e) return 'none';
      const final = scoreFromDraft(text);
      if (!e.changed && final === e.shown) return 'none';
      return writeIfNew(final) ? 'wrote' : 'none';
    },
  };
}
export type ScoreField = ReturnType<typeof createScoreField>;
