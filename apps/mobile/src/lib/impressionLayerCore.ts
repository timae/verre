// The moment impression LAYER's pure parts (build 2, ruled 2026-11-25; ADR-0011):
// the pager's index math and the active-page contract's transitions. No React,
// no React Native: node-importable for scripts/tests/impression-pager-units.ts
// and scripts/tests/impression-layer-units.ts. The functions a gesture worklet
// calls carry the 'worklet' directive (a plain string in node).
//
// The layer (components/moments/ImpressionLayer.tsx) renders the open
// impression and its two neighbours as LIVE pages in one translated row: the
// active page at `slot`, the previous at `slot - 1`, the next at `slot + 1`, each
// at `left: slot * width`; the row sits at `-slot * width` (+ the finger's
// offset while an edge swipe runs). A committed page change moves `slot` by one
// AFTER the slide has landed, so no mounted page ever moves in a React commit
// (a reorder of the line-up only changes who the neighbours are). Paging follows
// the line-up order (`wines`), whatever sort or search the line-up shows.

export const EDGE_STRIP = 15; // pt: the structure tracks start ~20 pt in (GUTTER 20)
export const EDGE_ACTIVATE = 10; // pt of horizontal travel before an edge swipe takes over
export const EDGE_FAIL_Y = 12; // pt of vertical travel that leaves the touch to the page
export const PAGE_COMMIT_FRACTION = 0.35; // of the width
export const PAGE_FLICK_VELOCITY = 600; // pt/s

export type LayerPage = { id: string; index: number; slot: number; active: boolean };

// A page change in flight RESERVES its source and destination (Codex review
// 2026-11-26): from the swipe's or the button's grant until the slide landed or
// was cancelled, exactly those two pages render, by wine id, whatever a poll
// does to the line-up meanwhile (a reorder never swaps the page under a slide,
// a removal never renders another wine under the destination's key).
export type PageReservation = { to: string; dir: -1 | 1 };

// The active wine and its line-up neighbours (±1), in line-up order. An active
// wine missing from `ids` (deleted, a hidden line-up) stays as the one page, with
// index -1, for its terminal transition. `neighbours` false = the active page
// alone (the open flight mounts only it). With a reservation: the active page
// and the reserved destination only (index -1 = it left the line-up).
export function pagerWindow(ids: readonly string[], activeId: string, slot: number, neighbours = true, reserved: PageReservation | null = null): LayerPage[] {
  if (reserved) {
    const pages: LayerPage[] = [
      { id: activeId, index: ids.indexOf(activeId), slot, active: true },
      { id: reserved.to, index: ids.indexOf(reserved.to), slot: slot + reserved.dir, active: false },
    ];
    return reserved.dir === -1 ? [pages[1], pages[0]] : pages;
  }
  const i = ids.indexOf(activeId);
  if (i < 0) return [{ id: activeId, index: -1, slot, active: true }];
  const out: LayerPage[] = [];
  if (neighbours && i > 0) out.push({ id: ids[i - 1], index: i - 1, slot: slot - 1, active: false });
  out.push({ id: activeId, index: i, slot, active: true });
  if (neighbours && i < ids.length - 1) out.push({ id: ids[i + 1], index: i + 1, slot: slot + 1, active: false });
  return out;
}

// The wine one step away in line-up order, or null at either end (first / last:
// "Nothing, like the post": no page change).
export function neighbourId(ids: readonly string[], activeId: string, dir: -1 | 1): string | null {
  const i = ids.indexOf(activeId);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < ids.length ? ids[j] : null;
}

// The row's translate at rest.
export function restX(slot: number, width: number): number {
  'worklet';
  return -slot * width + 0; // + 0: never -0
}

// iOS-style rubber band (UIScrollView's constant 0.55 over the width).
export function rubberBand(d: number, width: number): number {
  'worklet';
  if (width <= 0) return 0;
  const a = Math.abs(d);
  const r = (0.55 * a * width) / (width + 0.55 * a);
  return d < 0 ? -r : r;
}

// How far the row follows the finger during an edge swipe. `dir` = the page the
// strip pages to (-1: the LEFT strip, a rightward drag shows the previous page;
// 1: the RIGHT strip, a leftward drag shows the next). `free` = a neighbour
// exists and the swipe owns a transition: the row follows 1:1 up to one width;
// otherwise (first / last, or another transition in flight) a rubber band, a
// visual only. A drag back past the start never pages the other way.
export function edgeOffset(dx: number, width: number, dir: -1 | 1, free: boolean): number {
  'worklet';
  const d = dir === -1 ? Math.max(0, dx) : Math.min(0, dx);
  if (!free) return rubberBand(d, width);
  return Math.max(-width, Math.min(width, d));
}

// Where an edge release goes: -1 the previous page, 1 the next, 0 stay. Past
// PAGE_COMMIT_FRACTION of the width or a flick in the swipe's direction pages;
// a flick back toward the start cancels.
export function releaseTarget(dx: number, vx: number, width: number, dir: -1 | 1, canPage: boolean): -1 | 0 | 1 {
  'worklet';
  if (!canPage || width <= 0) return 0;
  const along = dir === -1 ? dx : -dx; // travel toward the destination
  const v = dir === -1 ? vx : -vx; // velocity toward the destination
  if (v < -PAGE_FLICK_VELOCITY / 2) return 0;
  if (along > width * PAGE_COMMIT_FRACTION || (along > 0 && v > PAGE_FLICK_VELOCITY)) return dir;
  return 0;
}

// A slide's completion (Codex review 2026-11-26): it commits the destination
// only when the spring FINISHED (an interrupted spring is no landing), the
// destination is still in the line-up and the layer still live; anything else
// cancels back to the source.
export function slideOutcome(ids: readonly string[], destId: string, live: boolean, finished: boolean): 'commit' | 'cancel' {
  return finished && live && ids.includes(destId) ? 'commit' : 'cancel';
}

// ─── edge swipes: who owns the row ──────────────────────────────────────
//
// An edge swipe's worklet starts optimistic, so the JS side decides (Codex
// review 2026-11-26): a swipe owns the row only once GRANTED ('page' = it took
// the transition guard; 'band' = first / last with nothing in flight: the
// rubber band only); a 'refused' swipe writes nothing at all. A release that
// arrives before the grant (a quick flick while the input was being captured)
// is kept and replayed by the grant; a stale gesture's grant or release is
// ignored. The layer authorizes every write of the row with the owner's id.
// 🔒 ONE run at a time (Codex recheck 2026-11-26): a swipe that starts while
// another is pending or granted (a second finger on the opposite edge) is
// refused at `start` and can never displace the run that holds the guard.
export type EdgeGrant = 'page' | 'band' | 'refused';
export type EdgeRelease = { target: -1 | 0 | 1; vx: number };

export function createEdgeRuns() {
  let run: { id: number; dir: -1 | 1; grant: EdgeGrant | null; released: EdgeRelease | null } | null = null;
  return {
    // false = another swipe holds the row: this one is refused (its grant and
    // release are ignored).
    start(id: number, dir: -1 | 1): boolean {
      if (run) return false;
      run = { id, dir, grant: null, released: null };
      return true;
    },
    // null = a stale id (revoked, or never started); else the release to replay now.
    grant(id: number, grant: EdgeGrant): { released: EdgeRelease | null } | null {
      if (!run || run.id !== id || run.grant !== null) return null;
      run.grant = grant;
      const released = run.released;
      if (released || grant === 'refused') run = null;
      // A refused swipe owns nothing: a release it deferred is dropped.
      return { released: grant === 'refused' ? null : released };
    },
    // 'deferred' = not granted yet (replayed by the grant); null = stale or refused.
    release(id: number, r: EdgeRelease): { grant: Exclude<EdgeGrant, 'refused'>; dir: -1 | 1 } | 'deferred' | null {
      if (!run || run.id !== id) return null;
      if (run.grant === null) {
        run.released = r;
        return 'deferred';
      }
      const { grant, dir } = run;
      run = null;
      return grant === 'refused' ? null : { grant, dir };
    },
    // The current run's direction (null = this id is no longer current).
    dirOf(id: number): -1 | 1 | null {
      return run && run.id === id ? run.dir : null;
    },
    // Another transition took the row (a button's page change, a close): the
    // current swipe's grant and release are void from here on.
    revoke() {
      run = null;
    },
  };
}

// ─── landing (closing folds back into the current row) ─────────────────

export type RowFrame = { x: number; y: number; width: number; height: number };
// The window band rows can be seen in: under the line-up's pinned toolbar,
// above the floating tab bar's clearance.
export type Band = { top: number; bottom: number };

// A row frame that lies wholly inside the band. Anything else (missing, empty,
// clipped by the toolbar or the tab bar) takes the bounded fade.
export function frameVisible(f: RowFrame | null, band: Band, slack = 0.5): boolean {
  if (!f || !(f.width > 0) || !(f.height > 0)) return false;
  return f.y >= band.top - slack && f.y + f.height <= band.bottom + slack;
}

// The scroll offset that brings a row into the band (centred in it), clamped to
// [0, maxY]; null = no scroll needed (it is already in, or the list can't move).
export function landingScroll(f: RowFrame, band: Band, scrollY: number, maxY: number): number | null {
  if (frameVisible(f, band)) return null;
  const target = scrollY + (f.y + f.height / 2) - (band.top + band.bottom) / 2;
  const y = Math.max(0, Math.min(Math.max(0, maxY), target));
  return Math.abs(y - scrollY) < 0.5 ? null : y;
}

// ─── transitions (the active-page contract) ────────────────────────────
//
// ⚠️ Every CONTROLLED departure (Previous, Next, Finish, an accepted edge swipe,
// the close button, Android Back after the sheet dismissal, a committed
// pull-down) shares the layer's ONE synchronous transition guard (build 1's
// createTransitionGuard; the pages' autosave hooks read it: edits made while
// it is held are dropped, so the layer gates the outgoing page's touches and
// VoiceOver for as long as it is held). Before `begin` the layer captures a
// focused text field (blur, its last events land first: Codex review
// 2026-11-26). `begin` acquires the guard and CAPTURES the outgoing page (its
// drain: staged and persisted on the phone, never waiting for the server)
// before anything moves; an edge swipe begins when it is GRANTED (just after it
// activates), a pull-down at its release (its touches are blocked from
// activation), so the write is normally done by the time the finger lifts.
// `end(true)` waits for that capture, then
// answers 'go' once (the same page still active, the layer still live and the
// destination still valid; the guard stays held while the caller slides or
// closes) or 'stay' (the guard back, the pager / layer returns to rest).
// ⚠️ A storage failure keeps a PAGE CHANGE on the page, but never traps the
// person: a CLOSE (the close button, Finish, Android Back, a committed
// pull-down) still leaves (build 1's rule: Back always leaves). The draft is
// already staged in memory, and the footer error or the outbox's after-leave
// alert says it wasn't stored (review 2026-11-26).
// `end(false)` (a cancelled gesture) and every 'stay' KEEP the guard (Codex
// recheck 2026-11-26): the page stays frozen, reserved and not VISIBLE until
// the caller's return to rest has landed and it calls `abandon()`; the staged
// edits stay in the outbox entry. `force` is a CONFIRMED terminal outcome (the
// bottle gone, Delete Impression): no capture, no wait, nothing after it.

export type LayerGuard = { readonly held: boolean; acquire(): boolean; release(): void };
export type LayerDest = { kind: 'page'; wineId: string; dir: -1 | 1 } | { kind: 'close' };
export type LayerOutcome = 'go' | 'stay';

export function createLayerTransitions(deps: {
  guard: LayerGuard;
  activeId: () => string;
  drain: (wineId: string) => Promise<boolean>;
  // Mounted, navigation-focused, not torn down.
  live: () => boolean;
  // The destination is still the outgoing page's neighbour in that direction.
  destValid: (dest: LayerDest, from: string) => boolean;
  // The guard's state, mirrored for the gesture worklets.
  onHeld?: (held: boolean) => void;
}) {
  type Run = { from: string; dest: LayerDest; drained: Promise<boolean>; ended: boolean; returning: boolean };
  let run: Run | null = null;
  let forced = false;
  const release = () => {
    deps.guard.release();
    deps.onHeld?.(false);
  };
  return {
    get busy(): boolean {
      return run !== null || forced || deps.guard.held;
    },
    get forced(): boolean {
      return forced;
    },
    // The departure under way (null while none, or while it returns to rest).
    current(): LayerDest | null {
      return run && !run.returning ? run.dest : null;
    },
    // A 'stay' (or a cancel) still returning to rest: the guard is held.
    get returning(): boolean {
      return !!run?.returning;
    },
    begin(dest: LayerDest): boolean {
      if (forced || run || !deps.guard.acquire()) return false;
      deps.onHeld?.(true);
      const from = deps.activeId();
      let drained: Promise<boolean>;
      try {
        drained = deps.drain(from).catch(() => false);
      } catch {
        drained = Promise.resolve(false);
      }
      run = { from, dest, drained, ended: false, returning: false };
      return true;
    },
    // 'stay' = the guard is still held: the caller returns to rest, then
    // calls `abandon()`.
    async end(commit: boolean): Promise<LayerOutcome> {
      const r = run;
      if (!r || r.ended) return 'stay';
      r.ended = true;
      if (!commit) {
        r.returning = true;
        return 'stay';
      }
      const ok = await r.drained;
      if (run !== r) return 'stay'; // a forced teardown took over (it keeps the guard)
      const stored = ok || r.dest.kind === 'close';
      if (!stored || !deps.live() || deps.activeId() !== r.from || !deps.destValid(r.dest, r.from)) {
        r.returning = true;
        return 'stay';
      }
      return 'go';
    },
    // The slide landed and the destination is the active page now.
    settle() {
      if (forced || !run) return;
      run = null;
      release();
    },
    // Back at rest after a 'stay' or a cancel, or a 'go' page change that did
    // not land (the spring interrupted, the destination gone, the layer
    // blurred): the source stays active, the guard goes back.
    abandon() {
      if (forced || !run) return;
      run = null;
      release();
    },
    force() {
      if (forced) return;
      forced = true;
      run = null;
      if (!deps.guard.held && deps.guard.acquire()) deps.onHeld?.(true);
    },
  };
}
export type LayerTransitions = ReturnType<typeof createLayerTransitions>;

// ─── text capture (a page's fields mid-edit) ───────────────────────────
//
// 🔒 A departure first waits for the page's text fields to FINISH editing
// natively (Codex recheck 2026-11-26): a field's last keystrokes, an IME
// commit and its end-editing commit reach JS as events AFTER the blur request,
// and React Native clears its focused-input record at once (the root's
// outside-touch dismissal does it on the touch-DOWN, before a button's
// onPress), so "is a field focused?" can't tell. Each rating field reports
// `focus` when it starts editing and `done` when its native edit ended (its
// blur / end-editing event, or its unmount). `capture()` resolves once none is
// open, or after the bounded belt; every departure JOINS the capture in
// flight. A field that never reports (the belt) is forgotten.
export const CAPTURE_BELT_MS = 300;
export function createInputCapture(opts: {
  beltMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const open = new Set<string>();
  let waiting: { promise: Promise<void>; resolve: () => void; timer: unknown } | null = null;
  const finish = () => {
    const w = waiting;
    if (!w) return;
    waiting = null;
    clearTimer(w.timer);
    w.resolve();
  };
  return {
    focus(id: string) {
      open.add(id);
    },
    done(id: string) {
      open.delete(id);
      if (open.size === 0) finish();
    },
    capture(): Promise<void> {
      if (waiting) return waiting.promise;
      if (open.size === 0) return Promise.resolve();
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      const w = { promise, resolve, timer: null as unknown };
      waiting = w;
      w.timer = setTimer(() => {
        if (waiting !== w) return;
        open.clear();
        finish();
      }, opts.beltMs);
      return promise;
    },
    get editing(): boolean {
      return open.size > 0;
    },
  };
}
export type InputCapture = ReturnType<typeof createInputCapture>;

// ─── the pull-down close (its guarded drain starts DURING the drag) ────
//
// Codex recheck 2026-11-26: a pull that activates captures the page's text
// and, once that capture completes and the pull is still on, BEGINS the close
// (the guard, the drain) while the finger is still down, so the write is
// normally done by the release. `release()` → 'close' (run the close) or
// 'open' (spring back, then `settled()`); `cancel()` (short of the line) keeps
// any guard it took until the spring back has landed and `settled()` gives it
// back. 'none' = nothing of this pull is left (a close took over).
export function createPullClose(deps: {
  tx: Pick<LayerTransitions, 'begin' | 'end' | 'abandon' | 'busy'>;
  capture: () => Promise<void>;
  closing: () => boolean;
  // The pull took the guard (the layer revokes an edge swipe's row).
  onBegun?: () => void;
}) {
  type Run = { cancelled: boolean; begun: boolean; ready: Promise<void> };
  let run: Run | null = null;
  let held = false; // a pull's guard waits for `settled()`
  const begin = (r: Run) => {
    if (r.begun || r.cancelled || run !== r || deps.closing() || !deps.tx.begin({ kind: 'close' })) return;
    r.begun = true;
    held = true;
    deps.onBegun?.();
  };
  return {
    // false = denied (a close runs, or another transition holds the guard).
    activate(): boolean {
      if (deps.closing() || deps.tx.busy || run) return false;
      const r: Run = { cancelled: false, begun: false, ready: Promise.resolve() };
      run = r;
      r.ready = deps.capture().then(
        () => begin(r),
        () => begin(r),
      );
      return true;
    },
    async release(): Promise<'close' | 'open' | 'none'> {
      const r = run;
      if (!r || deps.closing()) return 'none';
      await r.ready;
      if (run !== r) return 'none'; // cancelled meanwhile
      run = null;
      if (deps.closing()) return 'none';
      if (!r.begun) {
        // The begin at capture time was refused (something else held the
        // guard then): one more try; refused → back open, nothing held.
        if (!deps.tx.begin({ kind: 'close' })) return 'open';
        r.begun = true;
        held = true;
        deps.onBegun?.();
      }
      // Held at the release position until the edits are stored (a storage
      // failure still closes: never trapped).
      const outcome = await deps.tx.end(true);
      if (deps.closing()) return 'none';
      if (outcome === 'go') {
        held = false; // the close keeps the guard to the end
        return 'close';
      }
      return 'open'; // the guard waits for `settled()`
    },
    cancel() {
      const r = run;
      if (!r) return;
      r.cancelled = true;
      run = null;
      if (r.begun) void deps.tx.end(false);
    },
    // The spring back landed (or was cut by a close): the guard goes back.
    settled() {
      if (!held) return;
      held = false;
      deps.tx.abandon();
    },
    get held(): boolean {
      return held;
    },
    get active(): boolean {
      return run !== null;
    },
  };
}
