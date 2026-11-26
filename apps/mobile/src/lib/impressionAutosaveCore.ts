// The impression draft, pure (tasting-feedback build 1 § 1, the hook
// contract; units scripts/tests/rate-outbox-units.ts). `useImpressionAutosave`
// (lib/useImpressionAutosave.ts) wraps ONE controller per page; no router,
// route params or React here, so build 2 (the impression layer) mounts one per
// pager page.
//
// What a page shows, per field, in this order: its own UNSTAGED edit (the
// ~1 s the input takes to settle), the outbox ENTRY's edit (shared across
// mounts, persisted across restarts), then the OWN-RATING SNAPSHOT (the
// owner's remembered answer, else the caller's row in the current /state
// cache value). So a clean field is seeded and refreshed on its own even while
// another one is dirty, and an edit made before the stored rating arrived
// keeps the edit. The poll's retained last-good view is never a seed.
//
// ⚠️ RELATIVE edits (a structure axis spreads the shown map, an aroma add
// appends, VoiceOver's score step) are inert until `baselineReady` (a
// snapshot exists): sent before it, they would replace the stored field.
// The note keeps its RAW text while focused (the server's `scrub` trims, so a
// reseeded "dry" under the cursor would store "dryoak"); the canonical text
// takes over when editing ends, only if no newer edit exists.

import { fillFlavourZeros, gateAromaSelections, validateScore, type AxisKind } from '@verre/core';
import type { RatingMeta } from './api/rateTypes';
import { FIELDS, SAVE_ERROR_TEXT, type EntryMark, type Field, type FieldValues, type RateOutbox, type Snapshot } from './rateOutboxCore';

// The baseline a Clear confirm was opened on (`clearBaseline()` → `clearRating(token)`).
// `mark`: the entry pending when it was taken (its ack may advance the base).
// What one page renders from the outbox (one viewer × moment × wine): the SAME
// object while none of it changes, so a poll that only moves another bottle
// re-renders nothing here (Codex build 2 #7).
export type AutosaveSelection = {
  draft: FieldValues;
  savedState: SavedState;
  error: string | null;
  baselineReady: boolean;
  editable: boolean;
  clearPending: boolean;
  clearAsk: boolean;
};
const sameSelection = (a: AutosaveSelection, b: AutosaveSelection) =>
  a.savedState === b.savedState && a.error === b.error && a.baselineReady === b.baselineReady && a.editable === b.editable &&
  a.clearPending === b.clearPending && a.clearAsk === b.clearAsk &&
  a.draft.score === b.draft.score && a.draft.notes === b.draft.notes &&
  JSON.stringify(a.draft.flavors) === JSON.stringify(b.draft.flavors) && JSON.stringify(a.draft.aromas) === JSON.stringify(b.draft.aromas);

export type ClearToken = { viewer: string; code: string; wineId: string; base: Snapshot; foreign: number; mark?: EntryMark | null };

export const SETTLE_MS = 1000;
export type SavedState = 'saved' | 'local' | 'cleared-local' | 'error' | null;
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export const EMPTY_DRAFT: FieldValues = { score: 0, notes: '', flavors: {}, aromas: [] };

// The value a field is compared and sent as: the structure map filled
// (structure-wheel § 5, so an untouched sparse legacy row is never a change),
// the aromas through the gate (canonical), score and note as they are.
export function normalizeField<F extends Field>(field: F, value: FieldValues[F], kind: AxisKind): FieldValues[F] {
  if (field === 'flavors') return fillFlavourZeros(value as Record<string, number>, 'wine', kind) as FieldValues[F];
  if (field === 'aromas') return ((gateAromaSelections(value).value ?? value) as FieldValues[F]);
  return value;
}
// The gated aromas per snapshot row, so the shown draft keeps one identity
// across renders (the inputs see the same array until the row changes).
const gatedAromas = new WeakMap<object, FieldValues['aromas']>();
export function snapshotField<F extends Field>(field: F, rating: RatingMeta | null): FieldValues[F] {
  if (!rating) return EMPTY_DRAFT[field];
  if (field === 'aromas') {
    let g = gatedAromas.get(rating);
    if (!g) {
      g = gateAromaSelections(rating.aromas).value ?? [];
      gatedAromas.set(rating, g);
    }
    return g as FieldValues[F];
  }
  if (field === 'flavors') return ((rating.flavors ?? {}) as FieldValues[F]);
  if (field === 'notes') return ((rating.notes ?? '') as FieldValues[F]);
  return (Number(rating.score ?? 0) as FieldValues[F]);
}

// ONE synchronous transition guard for every CONTROLLED departure (Previous,
// Next, Finish; build 2: an accepted edge swipe, the layer's close). Acquire
// before capturing; while held, edits and further transitions wait.
export function createTransitionGuard() {
  let held = false;
  return {
    get held() {
      return held;
    },
    acquire(): boolean {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
  };
}
export type TransitionGuard = ReturnType<typeof createTransitionGuard>;

export type AutosaveController = ReturnType<typeof createAutosaveController>;

export function createAutosaveController(
  owner: RateOutbox,
  opts: { viewer: string; code: string; wineId: string; kind: AxisKind; timers: Timers; settleMs?: number },
) {
  const { viewer, code, wineId, timers } = opts;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  let kind = opts.kind;
  let pending: Partial<FieldValues> = {};
  // 🔒 The baseline (snapshot) and the offline provenance, LATCHED at the
  // first accepted edit of a clean draft (Codex P1): the edit is based on what
  // the page showed THEN, not on whatever a poll brought before the ~1 s stage.
  let latch: { base: Snapshot; offline: boolean; mark: EntryMark | null } | null = null;
  // Per field, the snapshot value when it was FIRST touched (Codex: the clean
  // value seen then decides "unchanged", never the latch's older snapshot).
  // `dirty`: the entry held a revision of that field when it was first
  // touched (a reversal of a value still on its way): it always goes out,
  // never compared (Codex recheck 3: no predecessor tracking).
  let seeds = new Map<Field, { snap: boolean; value: unknown; dirty: boolean }>();
  let noteFocused = false;
  let noteRaw: string | null = null; // the note's raw text while focused
  let timer: unknown = null;
  let clearGenSeen = owner.clearGen(viewer, code, wineId);
  let active = true;
  let suspended: () => boolean = () => false;
  let disposed = false;
  let localError: string | null = null;
  let ver = 0;
  let lastSelection: AutosaveSelection | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    ver++;
    for (const l of [...listeners]) l();
  };

  const cancelTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  // A successful Clear (here or on another mount of the same wine) invalidates
  // every draft created before it: this page resets from the post-Clear state
  // BEFORE taking input or capturing.
  const clearGenMoved = () => owner.clearGen(viewer, code, wineId) !== clearGenSeen;
  const syncClearGen = () => {
    if (!clearGenMoved()) return;
    clearGenSeen = owner.clearGen(viewer, code, wineId);
    pending = {};
    latch = null;
    seeds = new Map();
    noteRaw = null;
    cancelTimer();
  };

  const snapshot = () => owner.snapshot(viewer, code, wineId);

  const draft = (): FieldValues => {
    const e = owner.entry(viewer, code, wineId);
    if (e?.clear) return EMPTY_DRAFT;
    const stale = clearGenMoved();
    const p = stale ? {} : pending;
    const snap = snapshot();
    const base = snap?.rating ?? null;
    const pick = <F extends Field>(f: F): FieldValues[F] =>
      (p[f] as FieldValues[F] | undefined) ?? (e?.fields[f]?.value as FieldValues[F] | undefined) ?? snapshotField(f, base);
    return {
      score: pick('score'),
      notes: !stale && noteFocused && noteRaw !== null ? noteRaw : pick('notes'),
      flavors: pick('flavors'),
      aromas: pick('aromas'),
    };
  };

  const stageAll = () => {
    syncClearGen();
    for (const f of FIELDS) {
      const v = pending[f];
      if (v === undefined) continue;
      if (f === 'score' && validateScore(v).error) continue; // never a 400 for the slider's rounding
      const value = normalizeField(f, v as never, kind);
      const sd = seeds.get(f);
      const seed = sd && sd.snap && !sd.dirty ? normalizeField(f, sd.value as never, kind) : undefined;
      owner.stage(viewer, code, wineId, f, value, seed, latch ?? undefined);
    }
    pending = {};
    latch = null;
    seeds = new Map();
    emit();
  };
  // The page's unsettled fields, as they would be staged.
  const unsettled = (): Partial<FieldValues> => {
    const out: Partial<FieldValues> = {};
    for (const f of FIELDS) {
      const v = pending[f];
      if (v === undefined || (f === 'score' && validateScore(v).error)) continue;
      (out as Record<string, unknown>)[f] = normalizeField(f, v as never, kind);
    }
    return out;
  };

  const editable = () =>
    !disposed && active && !suspended() && owner.ready(viewer) && !owner.entry(viewer, code, wineId)?.clear;

  const edit = <F extends Field>(field: F, value: FieldValues[F], relative: boolean) => {
    if (!editable()) return;
    syncClearGen();
    if (relative && snapshot() === null) return;
    // The draft's first edit latches the baseline; EVERY edit made offline
    // marks it (Codex: the conflict rule follows where the edit was made).
    if (Object.keys(pending).length === 0 || !latch) latch = { base: snapshot(), offline: false, mark: owner.pendingMark(viewer, code, wineId) };
    if (!owner.online()) latch.offline = true;
    if (!seeds.has(field)) {
      const snap = snapshot();
      const dirty = owner.hasRevision(viewer, code, wineId, field);
      seeds.set(field, snap ? { snap: true, value: snapshotField(field, snap.rating), dirty } : { snap: false, value: undefined, dirty });
    }
    pending = { ...pending, [field]: value };
    if (field === 'notes' && noteFocused) noteRaw = value as string;
    arm();
    emit();
  };
  // The one trailing timer, re-armed by every edit.
  function arm() {
    cancelTimer();
    timer = timers.set(() => {
      timer = null;
      if (!disposed) stageAll();
    }, settleMs);
  }

  const ctl = {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    version: () => ver,
    setKind(next: AxisKind) {
      kind = next;
    },
    // build 2: an inactive page takes no NEW writes (a captured departure still
    // finishes). Build 1: always true.
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      emit();
    },
    // The screen's transition guard: held = edits wait.
    setSuspended(fn: () => boolean) {
      suspended = fn;
    },

    draft,
    // The page's whole render input, identity-stable while unchanged (a
    // `useSyncExternalStore` snapshot over the outbox AND this controller).
    selection: (): AutosaveSelection => {
      const next: AutosaveSelection = {
        draft: draft(),
        savedState: ctl.savedState(),
        error: ctl.error(),
        baselineReady: snapshot() !== null,
        editable: editable(),
        clearPending: !!owner.entry(viewer, code, wineId)?.clear,
        clearAsk: owner.clearAskPending(viewer, code, wineId),
      };
      if (lastSelection && sameSelection(lastSelection, next)) return lastSelection;
      lastSelection = next;
      return next;
    },
    baselineReady: () => snapshot() !== null,
    ready: () => owner.ready(viewer),
    clearPending: () => !!owner.entry(viewer, code, wineId)?.clear,
    editable,

    // Absolute edits (the slider, typed score, the note) start at once.
    setScore: (v: number) => edit('score', v, false),
    setNotes: (v: string) => edit('notes', v, false),
    // Relative edits wait for the baseline.
    stepScore: (v: number) => edit('score', v, true),
    setFlavors: (v: Record<string, number>) => edit('flavors', v, true),
    setAromas: (v: FieldValues['aromas']) => edit('aromas', v, true),
    setNoteFocused(focused: boolean) {
      if (focused === noteFocused) return;
      noteFocused = focused;
      syncClearGen();
      noteRaw = focused ? draft().notes : null;
      emit();
    },

    // A departure: cancel the trailing timer, stage what is unstaged and wait
    // until it is PERSISTED (never for the server). false = storage failed or
    // didn't settle in 2 s (the page stays and shows the error).
    async drain(): Promise<boolean> {
      cancelTimer();
      if (Object.keys(pending).length) stageAll();
      const ok = await owner.persisted(viewer, code, wineId);
      if (!ok) localError = SAVE_ERROR_TEXT; // stays until the next GOOD save
      emit();
      return ok;
    },
    // The baseline the page DISPLAYS, taken when the Clear confirm OPENS (a
    // poll may move the snapshot while the alert is up).
    clearBaseline(): ClearToken {
      return { viewer, code, wineId, base: snapshot(), foreign: owner.foreignRebases(viewer, code, wineId), mark: owner.pendingMark(viewer, code, wineId) };
    },
    // Clear My Rating, after the in-place confirm: on the token's baseline when
    // there is no entry yet; the unsettled fields go into the restore snapshot
    // with the entry's (atomically, never a merge of their own).
    async clearRating(token?: ClearToken): Promise<boolean> {
      if (!owner.ready(viewer) || disposed) return false;
      if (token && (token.viewer !== viewer || token.code !== code || token.wineId !== wineId)) return false;
      syncClearGen();
      cancelTimer();
      // Never on an unknown baseline (Codex P1): a confirm opened before the
      // rating loaded deletes nothing.
      const base = token ? token.base : snapshot();
      if (base === null) {
        if (Object.keys(pending).length) arm();
        return false;
      }
      const extra = unsettled();
      if (!owner.clear(viewer, code, wineId, { base, extra, foreign: token?.foreign, mark: token ? token.mark : undefined })) {
        if (Object.keys(pending).length) arm(); // refused: the unsettled edits still settle
        emit();
        return false;
      }
      pending = {};
      latch = null;
      seeds = new Map();
      noteRaw = null;
      emit();
      return owner.persisted(viewer, code, wineId);
    },
    // ONLY for a confirmed terminal outcome (the bottle gone from a present
    // line-up, a confirmed removal, a successful Delete Impression).
    // What the page SAW (the bottle gone, a removal): its work ends, the
    // unsettled draft is STAGED (nothing typed is lost) and the stored entry
    // stays: the runner sends it and the server's answer decides (404 / 403 /
    // 401 removed drop it). `confirmed` (Delete Impression's success, its own
    // answer): the draft and the stored entry go at once.
    discardPending(opts?: { confirmed?: boolean }) {
      cancelTimer();
      noteRaw = null;
      if (!opts?.confirmed) return stageAll();
      pending = {};
      latch = null;
      seeds = new Map();
      owner.discard(viewer, code, wineId, opts);
      emit();
    },

    // The footer: "Saved" only for fields unchanged since that save (any
    // unstaged edit hides it), "Saved on this phone" while a PERSISTED entry
    // waits or retries, nothing while the first attempt is on the wire.
    savedState(): SavedState {
      const st = owner.status(viewer, code, wineId);
      if (localError && st.saved) localError = null; // a good save landed
      if (localError || st.error) return 'error';
      if (!clearGenMoved() && Object.keys(pending).length) return null;
      if (st.clear) return st.persisted && !st.firstAttemptInFlight ? 'cleared-local' : null;
      if (st.pending) return st.persisted && !st.firstAttemptInFlight ? 'local' : null;
      return st.saved ? 'saved' : null;
    },
    error(): string | null {
      const st = owner.status(viewer, code, wineId);
      if (localError && st.saved) localError = null;
      return st.error ?? localError;
    },

    // Mounted again (an effect re-run): take input again.
    revive() {
      disposed = false;
    },
    // Unmount: anything unstaged goes into the entry (the focus cleanup has
    // normally captured it already).
    dispose() {
      if (disposed) return;
      cancelTimer();
      if (Object.keys(pending).length) stageAll();
      disposed = true;
    },
  };
  return ctl;
}
