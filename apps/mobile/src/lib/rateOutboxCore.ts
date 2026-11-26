// The rating OUTBOX, pure (tasting-feedback build 1 § 1; units
// scripts/tests/rate-outbox-units.ts). Every dependency is injected
// (storage, clock, network, auth, fetch, the query cache), so this module
// imports no React Native and runs under node. `lib/rateOutbox.ts` binds it to
// the app (AsyncStorage, NetInfo, apiFetch, the QueryClient, Alert).
//
// 🔒 THE ENTRY IS THE ONLY QUEUE STATE. One entry per viewer (public id) ×
// moment × wine, persisted; no list of jobs. It holds the EDITED fields only
// (each with an entry-wide revision), the revisions the server acknowledged,
// the BASE (the rating version the edits are based on, fixed when the entry is
// created, moved only by the server's answers to this entry's own ops), the
// one op that may be on the wire (`unresolvedOp`, re-sent EXACTLY until it is
// answered) and a staged Clear.
//
// 🔒 ONE OWNER per entry key. Every transition (hydration, staging, an
// answer, removal) is a SYNCHRONOUS step on the in-memory entry, so the steps
// are serialised by construction; each one is then PERSISTED (write-ahead): an
// op is sent only once the entry that carries it is on disk, and the footer
// says "Saved on this phone" only for a persisted entry. A failed write keeps
// the state in memory and retries.
//
// 🔒 THE CREDENTIAL'S OWNER. Every body carries `viewer` (`u:<publicId>`, the
// entry's own; the server answers 409 `wrongViewer` and writes nothing when
// the cookie isn't that account's). Before the first send of an auth
// generation, and before a read is taken as a base, get-session must confirm
// the cookie is this viewer's; a mismatch holds the queue. The whole gate is
// checked again after the write-ahead wait and inside the binding's
// `beforeSend` (a close cancels locally; the persisted op stays).
//
// The answer table (`apply`) and the runner's order (`nextOp`) are the
// contract of record in .local/tasting-feedback/build-prompt.md § 1 and
// docs/dev/rating-saves.md; keep the three in step.

import { scrub, type AromaSelection } from '@verre/core';
import type { RateBody, RateResult, RatingMeta, RatingsView } from './api/rateTypes';

export type Field = 'score' | 'notes' | 'flavors' | 'aromas';
export const FIELDS: readonly Field[] = ['score', 'notes', 'flavors', 'aromas'];
export type Aroma = AromaSelection;
export type FieldValues = { score: number; notes: string; flavors: Record<string, number>; aromas: Aroma[] };
export type Revs = Partial<Record<Field, number>>;
type FieldSlots = { [F in Field]?: { value: FieldValues[F]; rev: number } };

export type StoredOp = { opId: string; body: RateBody; baseVersion: number; revs: Revs };

export type Entry = {
  viewer: string;
  code: string;
  wineId: string;
  fields: FieldSlots;
  ackRev: Revs;
  // Revisions an `unchanged` answer parked: not re-sent on their own, only with
  // a newer edit (the merged result was empty, the server wrote nothing).
  parked: Revs;
  nextRev: number;
  baseVersion: number | 'unknown';
  baseHadRating: boolean | 'unknown';
  unresolvedOp?: StoredOp;
  // `restoreRevs`: the revision each restored value came from (a predecessor's
  // retirement prunes what it covered; an unsettled value has none: kept).
  clear?: { opId: string; baseVersion?: number; restore: Partial<FieldValues>; restoreRevs?: Revs };
  // Loaded from storage at launch, edited offline, or sat through an outage
  // with unsent revisions: "newer rating wins" (a foreign 409 drops it).
  waited: boolean;
  // The one live rebase is used for these edits (a second foreign 409 drops).
  rebased: boolean;
  // The entry's first acknowledged save happened (my-sessions + profile header).
  acked: boolean;
  // Earliest next send (429 / 503 / the backoff), persisted.
  nextAt: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  // The last EDIT (a staged field or a Clear), never a backoff or a hydration
  // write: the 90-day clean-up counts from here (absent on older entries:
  // `updatedAt` stands in).
  editedAt?: number;
};

// A wine's own-rating SNAPSHOT: `{ rating }` (null = "no rating") or none.
export type Snapshot = { rating: RatingMeta | null } | null;

export type Stamp = { epoch: number; gen: number };
export type ReadOutcome =
  | { kind: 'ok'; ratings: RatingsView | null }
  | { kind: 'gone' }
  | { kind: 'removed' }
  | { kind: 'invalid' }
  | { kind: 'update-required' }
  | { kind: 'retry' };
export type SessionCheck = 'same' | 'other' | 'none' | 'unknown';
// Opaque: the entry pending when a baseline / a field was captured (its object
// identity: an entry is mutated in place through its acks, a new one is new).
export type EntryMark = object;

export interface OutboxStorage {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface OutboxDeps {
  storage: OutboxStorage;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isOnline(): boolean;
  appActive(): boolean;
  newOpId(): string;
  // The viewer epoch + auth generation a dispatch is stamped with, and whether
  // a stamp is still current (lib/query.tsx, lib/authGate.ts).
  stamp(): Stamp;
  stampCurrent(s: Stamp): boolean;
  // The rate POST. The binding re-checks the stamp, the signed-out latch AND
  // `stillEligible()` (online, not stopped / paused, the owner confirmed, the
  // entry not discarded) after the cookie read, and answers `cancelled`
  // without sending.
  send(code: string, body: RateBody, stamp: Stamp, stillEligible: () => boolean): Promise<RateResult>;
  // One exact /state read for a moment (into the query cache).
  // `stamp`: the auth state at dispatch; the binding re-checks it after the
  // cookie read (a moved stamp is never sent), the core again at completion.
  readState(viewer: string, code: string, stamp: Stamp): Promise<ReadOutcome>;
  // get-session, compared with the viewer (the 401 `invalid` confirm).
  confirmSession(viewer: string): Promise<SessionCheck>;
  // The ratings section of the CURRENT ['session-state', code, viewer] value.
  // The cached ratings section + the auth generation its fetch STARTED under:
  // only a section of the current, confirmed generation is a snapshot.
  readRatings(viewer: string, code: string): { ratings: RatingsView | null | undefined; gen: number } | undefined;
  // Patch (null = remove) ONLY the caller's rating in a PRESENT section, else a
  // fresh exact read; cancels the in-flight read first.
  patchCache(viewer: string, code: string, wineId: string, rating: RatingMeta | null): void;
  afterFirstAck(viewer: string, code: string): void;
  // The after-leave alert; `done` when it is dismissed.
  alert(title: string, message: string, done: () => void): void;
  label(viewer: string, code: string, wineId: string): string | null;
  log?(message: string, data?: unknown): void;
}

export const STORAGE_PREFIX = 'verre.rateOutbox.v1|';
export const CLEANUP_MS = 90 * 24 * 3600_000;
export const WAITER_TIMEOUT_MS = 2000;
const BACKOFF_FIRST_MS = 5000;
const BACKOFF_CAP_MS = 5 * 60_000;
const STAMP_RETRY_MS = 1000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const WRITE_RETRY_FIRST_MS = 1000;
const WRITE_RETRY_CAP_MS = 30_000;

// Footer copy (build prompt § 1: "Saved", "Saved on this phone", "Cleared on
// this phone", the after-leave alert). The storage and drop errors reuse the
// first sentence of the screen's earlier save error.
export const SAVE_ERROR_TEXT = 'Couldn’t save your rating.';
export const ALERT_TITLE = 'Rating Not Saved';
export const alertMessage = (label: string) => `Your last changes to ${label} couldn’t be saved.`;

export const keyOf = (viewer: string, code: string, wineId: string) => `${viewer}\u0001${code}\u0001${wineId}`;
const vcOf = (viewer: string, code: string) => `${viewer}\u0001${code}`;
export const storageKey = (viewer: string, code: string, wineId: string) =>
  `${STORAGE_PREFIX}${encodeURIComponent(viewer)}|${encodeURIComponent(code)}|${encodeURIComponent(wineId)}`;
export const backoffMs = (attempts: number) => Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);

// ── Field values: normalized comparison (the note as the server stores it) ──

const stable = (v: unknown): string => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
};
export const noteOut = (s: string | null | undefined) => scrub(s ?? '') ?? '';
export function sameField(field: Field, a: unknown, b: unknown): boolean {
  if (field === 'notes') return noteOut(a as string) === noteOut(b as string);
  if (field === 'score') return Number(a ?? 0) === Number(b ?? 0);
  return stable(a) === stable(b);
}
// § 1b's engagement rule: score 0, no structure axis above 0, no aromas, a
// blank note.
export function isEmptyRating(r: { score?: number; flavors?: Record<string, number>; aromas?: unknown[]; notes?: string }): boolean {
  return !(Number(r.score ?? 0) > 0) && !Object.values(r.flavors ?? {}).some((x) => Number(x) > 0) && !(r.aromas?.length) && noteOut(r.notes) === '';
}

function unsent(e: Entry): Field[] {
  return FIELDS.filter((f) => e.fields[f] !== undefined && e.fields[f]!.rev > (e.ackRev[f] ?? 0));
}
// Something to send on its own: an unsent revision an `unchanged` didn't park.
function hasSendable(e: Entry): boolean {
  return unsent(e).some((f) => e.parked[f] !== e.fields[f]!.rev);
}
function isEmptyEntry(e: Entry): boolean {
  return Object.keys(e.fields).length === 0 && !e.clear && !e.unresolvedOp;
}

// One refusal waiting on the account check (its slot as it was, what "same" does).
type Refusal = { s: Slot; inc: number; dropOnSame: boolean; stillCovered?: (s: Slot) => boolean; onSame?: (s: Slot) => void };
// What one dispatched op submitted (its entry, id, kind, field revisions).
type Coverage = { entry: Entry; opId: string; kind: 'merge' | 'clear'; revs: Revs };

export type KeyStatus = {
  ready: boolean;
  pending: boolean; // unsent or unanswered revisions (parked ones excluded)
  clear: boolean;
  persisted: boolean;
  firstAttemptInFlight: boolean;
  saved: boolean;
  error: string | null;
  baselineReady: boolean;
};

type Slot = {
  key: string;
  // Discarded before its stored value was read: the read must NOT adopt it.
  discarded: boolean;
  // After a failed hydration: false until this key's stored value was read
  // (and merged); no write, no send before.
  verified: boolean;
  loading: boolean;
  loadAttempts: number;
  mem: Entry | null;
  memV: number;
  diskV: number;
  writing: boolean;
  writeFailed: boolean;
  writeAttempts: number;
  writeTimer: unknown;
  inFlight: boolean;
  firstAttempt: boolean;
  incarnation: number;
  diskWaiters: { target: number; resolve: (ok: boolean) => void; timer?: unknown }[];
};

export type RateOutbox = ReturnType<typeof createRateOutbox>;

export function createRateOutbox(deps: OutboxDeps) {
  // ── per activation (a signed-in viewer) ──────────────────────────────────
  let viewer: string | null = null;
  let activation = 0;
  let ready = false;
  let stopped = false; // 401 `invalid` / signed out: until the viewer's next sign-in
  let updateStopped = false; // update_required: until the next launch
  let viewerPauseUntil = 0; // a 429
  // Hydration's read failed: every key is read on its own (and merged) before
  // its first write, so a fresh entry never replaces a stored one unread.
  let hydrationFailed = false;
  // 🔒 The CREDENTIAL's owner (Codex P1): before the runner sends anything
  // after a launch or an auth-generation change, and before a background
  // /state read is trusted as a base, get-session must say the cookie is this
  // viewer's (a failed session-cache clear + another sign-in + a restart can
  // hydrate one account's queue under another's cookie). `ownerGen` = the
  // auth generation it was confirmed at; a mismatch holds the queue until the
  // generation or the viewer moves; no answer retries with the backoff.
  let ownerGen: number | null = null;
  let ownerChecking = false;
  let ownerMismatchGen: number | null = null;
  let ownerRetry: { timer: unknown; ask: () => void } | null = null;
  let ownerMoved = 0; // consecutive answers that came back under a moved generation
  let ownerNextAt = 0;
  let invalidRetry: { timer: unknown; ask: () => void } | null = null;
  // The ONE pending account check after refusals, with every refusal it covers.
  let invalidCheck: { act: number; who: string; items: Refusal[]; queued: Refusal[] } | null = null;
  let online = deps.isOnline();
  let appActive = deps.appActive();
  let wakeTimer: unknown = null;
  let wakeAt = Infinity;
  const slots = new Map<string, Slot>();
  // In-memory, per activation: remembered answers (+ the raw generation they
  // were taken at), raw-section generations, Clear generations, the 503
  // pauses per moment, reads in flight, the footer marks.
  const remembered = new Map<string, { rating: RatingMeta | null; gen: number }>();
  const rawGen = new Map<string, number>();
  const clearGens = new Map<string, number>();
  // A 503'd moment: paused until `until`, then ONE entry (`probe`, its key) probes.
  // `probe`: the token of the ONE dispatch probing; only it releases it.
  const moment503 = new Map<string, { until: number; backoff: number; probe: number | null }>();
  let probeSeq = 0;
  const releaseProbe = (code: string, token: number | null) => {
    const mp = moment503.get(code);
    if (token !== null && mp && mp.probe === token) mp.probe = null;
  };
  // This phone's last OWN acknowledged save per key (Fable): its version and
  // the entry it came from. A captured baseline advances ONLY through an ack
  // of the entry that was pending when it was captured (Codex recheck 2).
  const ownAcked = new Map<string, { v: number; entry: Entry }>();

  // Foreign rebases per key (an entry's base moved by another writer's save).
  const foreign = new Map<string, number>();
  const reads = new Map<string, { inFlight: boolean; nextAt: number; attempts: number }>();
  const savedMarks = new Set<string>();
  const overlayMemo = new Map<string, { ratings: RatingsView | null; sig: string; result: RatingsView | null }>();
  const errors = new Map<string, string>();
  const visible = new Map<string, Set<number>>();
  const labels = new Map<string, string>();
  const clearAsks = new Set<string>();
  const pendingAlerts: string[] = [];
  let alertOpen = false;

  const listeners = new Set<() => void>();
  let ver = 0;
  const notify = () => {
    ver++;
    for (const l of [...listeners]) l();
  };
  const log = (m: string, d?: unknown) => deps.log?.(m, d);

  const slotFor = (key: string): Slot => {
    let s = slots.get(key);
    if (!s) {
      s = { key, discarded: false, verified: !hydrationFailed, loading: false, loadAttempts: 0, mem: null, memV: 0, diskV: 0, writing: false, writeFailed: false, writeAttempts: 0, writeTimer: null, inFlight: false, firstAttempt: false, incarnation: 0, diskWaiters: [] };
      slots.set(key, s);
    }
    return s;
  };
  const entryOf = (v: string, code: string, wineId: string) => slots.get(keyOf(v, code, wineId))?.mem ?? null;

  // ── persistence (write-ahead, retried) ───────────────────────────────────
  const settleWaiters = (s: Slot, ok: boolean | null) => {
    s.diskWaiters = s.diskWaiters.filter((w) => {
      if (ok === false || s.diskV >= w.target) {
        if (w.timer !== undefined) deps.clearTimer(w.timer);
        w.resolve(ok !== false);
        return false;
      }
      return true;
    });
  };
  const commit = (s: Slot) => {
    if (s.mem) s.mem.updatedAt = deps.now();
    s.memV++;
    notify();
    flush(s);
  };
  const flush = (s: Slot) => {
    if (s.writing) return;
    if (!s.verified) return void loadKey(s);
    if (s.diskV >= s.memV) return;
    const act = activation;
    s.writing = true;
    const target = s.memV;
    const e = s.mem;
    const k = e ? storageKey(e.viewer, e.code, e.wineId) : diskKeyOf(s.key);
    const write = e ? deps.storage.setItem(k, JSON.stringify(e)) : deps.storage.removeItem(k);
    write.then(
      () => {
        s.writing = false;
        if (act !== activation) return;
        s.diskV = Math.max(s.diskV, target);
        s.writeAttempts = 0;
        const wasFailed = s.writeFailed;
        s.writeFailed = false;
        settleWaiters(s, null);
        if (wasFailed) notify();
        if (s.diskV < s.memV) flush(s);
        else pump();
      },
      (err) => {
        s.writing = false;
        if (act !== activation) return;
        log('[rateOutbox] storage write failed', err);
        s.writeFailed = true;
        s.writeAttempts++;
        settleWaiters(s, false);
        notify();
        if (s.writeTimer) deps.clearTimer(s.writeTimer);
        s.writeTimer = deps.setTimer(() => {
          s.writeTimer = null;
          if (act === activation) flush(s);
        }, Math.min(WRITE_RETRY_FIRST_MS * 2 ** (s.writeAttempts - 1), WRITE_RETRY_CAP_MS));
      },
    );
  };
  // One key's stored value, read and MERGED under the page's edits (the
  // stored base, op and waited flag kept; the new edits on top as newer
  // revisions; a stored Clear wins). A failed read keeps the edits in memory
  // and retries before any write.
  const loadKey = async (s: Slot) => {
    if (s.loading || s.verified) return;
    const act = activation;
    s.loading = true;
    let raw: string | null = null;
    let ok = true;
    try {
      const rows = await deps.storage.multiGet([diskKeyOf(s.key)]);
      raw = rows[0]?.[1] ?? null;
    } catch (err) {
      ok = false;
      log('[rateOutbox] storage read failed', err);
    }
    s.loading = false;
    if (act !== activation) return;
    if (!ok) {
      s.loadAttempts++;
      deps.setTimer(() => {
        if (act === activation) void loadKey(s);
      }, Math.min(WRITE_RETRY_FIRST_MS * 2 ** (s.loadAttempts - 1), WRITE_RETRY_CAP_MS));
      return;
    }
    let stored: Entry | null = null;
    try {
      stored = raw ? (JSON.parse(raw) as Entry) : null;
    } catch {
      stored = null;
    }
    if (stored && stored.viewer === viewer && !s.discarded) {
      stored.parked ??= {};
      stored.ackRev ??= {};
      stored.fields ??= {};
      stored.editedAt ??= stored.updatedAt;
      stored.waited = true;
      const mine = s.mem;
      if (mine?.clear && !stored.clear) {
        // The stored edits under the page's own restore (the page's win).
        const restore: Partial<FieldValues> = {};
        const restoreRevs: Revs = {};
        for (const f of FIELDS) {
          if (!stored.fields[f]) continue;
          (restore as Record<string, unknown>)[f] = stored.fields[f]!.value;
          restoreRevs[f] = stored.fields[f]!.rev; // provenance: a stored op's retirement prunes it
        }
        // The newer page draft's values have none: they survive any retirement.
        for (const f of FIELDS) if (mine.clear.restore[f] !== undefined) delete restoreRevs[f];
        stored.fields = {};
        stored.parked = {};
        stored.clear = { opId: mine.clear.opId, restore: { ...restore, ...mine.clear.restore }, restoreRevs };
      } else if (mine && !stored.clear) {
        for (const f of FIELDS) {
          const slot = mine.fields[f];
          if (slot) (stored.fields as Record<string, unknown>)[f] = { value: slot.value, rev: ++stored.nextRev };
        }
      }
      if (mine) stored.editedAt = Math.max(stored.editedAt ?? 0, mine.editedAt ?? 0);
      s.mem = stored;
    }
    s.verified = true;
    s.discarded = false;
    commit(s);
    pump();
  };
  // The removed entry's storage key (its slot has no entry any more).
  const diskKeyOf = (key: string) => {
    const [v, c, w] = key.split('\u0001');
    return storageKey(v, c, w);
  };
  // Resolves true once the slot's CURRENT state is on disk; false on a failed
  // write, or (departure waiters) when it isn't settled within `timeoutMs`,
  // while the owner keeps retrying.
  const waitDisk = (s: Slot, timeoutMs?: number): Promise<boolean> => {
    if (s.diskV >= s.memV) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w: Slot['diskWaiters'][number] = { target: s.memV, resolve };
      if (timeoutMs !== undefined) {
        w.timer = deps.setTimer(() => {
          s.diskWaiters = s.diskWaiters.filter((x) => x !== w);
          resolve(false);
        }, timeoutMs);
      }
      s.diskWaiters.push(w);
    });
  };

  // ── snapshot + remembered answers ────────────────────────────────────────
  const snapshotOf = (v: string, code: string, wineId: string): Snapshot => {
    const rem = remembered.get(keyOf(v, code, wineId));
    const gen = rawGen.get(vcOf(v, code)) ?? 0;
    if (rem && rem.gen === gen) return { rating: rem.rating };
    const cached = deps.readRatings(v, code);
    const section = cached && cached.gen === deps.stamp().gen && ownerOk() ? cached.ratings : undefined;
    if (section) return { rating: section[`u:${v}`]?.ratings[wineId] ?? null };
    if (rem) return { rating: rem.rating };
    return null;
  };
  const remember = (v: string, code: string, wineId: string, rating: RatingMeta | null) => {
    remembered.set(keyOf(v, code, wineId), { rating, gen: rawGen.get(vcOf(v, code)) ?? 0 });
  };
  const baseFrom = (snap: Snapshot): [number | 'unknown', boolean | 'unknown'] =>
    snap === null ? ['unknown', 'unknown'] : snap.rating ? [snap.rating.v ?? 0, true] : [0, false];

  const newEntry = (v: string, code: string, wineId: string, base?: Snapshot, mark?: EntryMark | null): Entry => {
    let [baseVersion, baseHadRating] = baseFrom(base !== undefined ? base : snapshotOf(v, code, wineId));
    // A latch or Clear token taken while an entry was pending, which has been
    // acknowledged since: that OWN save is what the page shows, it is the
    // base (Fable). Any other baseline stays (a confirmed empty one keeps
    // `0, false`: a re-rate after a web Reset, Codex recheck 2).
    const own = ownAcked.get(keyOf(v, code, wineId));
    if (mark && own && own.entry === mark && typeof baseVersion === 'number' && own.v > baseVersion) [baseVersion, baseHadRating] = [own.v, true];
    const t = deps.now();
    return { viewer: v, code, wineId, fields: {}, ackRev: {}, parked: {}, nextRev: 0, baseVersion, baseHadRating, waited: !online, rebased: false, acked: false, nextAt: 0, attempts: 0, createdAt: t, updatedAt: t, editedAt: t };
  };

  // ── visibility, alerts ───────────────────────────────────────────────────
  const isVisible = (key: string) => appActive && (visible.get(key)?.size ?? 0) > 0;
  const showNextAlert = () => {
    if (alertOpen || !appActive || viewer === null) return;
    const key = pendingAlerts.shift();
    if (key === undefined) return;
    const [v, c, w] = key.split('\u0001');
    if (v !== viewer) return showNextAlert();
    // No name known for it (an entry from an earlier launch whose moment
    // isn't loaded): no alert rather than copy that wasn't ruled (parked).
    const label = labels.get(key) ?? deps.label(v, c, w);
    if (!label) return showNextAlert();
    alertOpen = true;
    const act = activation;
    deps.alert(ALERT_TITLE, alertMessage(label), () => {
      if (act !== activation) return;
      alertOpen = false;
      showNextAlert();
    });
  };
  // A definitive drop with the footer error: a visible page shows it in its
  // footer; otherwise ONE alert per viewer at a time (deferred while the app is
  // in the background).
  const dropWithError = (s: Slot, message: string) => {
    s.mem = null;
    s.incarnation++;
    commit(s);
    raiseError(s, message);
  };
  // 🔒 A terminal answer about op X acts ONLY on what X submitted (Codex
  // recheck 6): X, its revisions and its Clear are retired; newer revisions
  // (or a Clear staged after X) keep the entry and go out as a fresh op that
  // the server answers for itself. `cov` is captured at DISPATCH.
  // Returns whether it discarded a revision the person still wants (one no
  // newer revision supersedes): only that is worth an error (recheck 7).
  const retireOp = (s: Slot, cov: Coverage): boolean => {
    const e = s.mem;
    if (!e || e !== cov.entry) return false; // another entry now: not X's to touch
    let lost = false;
    if (e.unresolvedOp?.opId === cov.opId) delete e.unresolvedOp;
    if (cov.kind === 'clear' && e.clear?.opId === cov.opId) {
      delete e.clear;
      lost = true;
    }
    for (const f of FIELDS) {
      const r = cov.revs[f];
      if (r === undefined) continue;
      if (e.fields[f] && e.fields[f]!.rev <= r) {
        delete e.fields[f];
        delete e.parked[f];
        lost = true;
      }
      // A Clear staged behind X keeps what X covered out of its restore
      // (provenance: later edits stay).
      const rr = e.clear?.restoreRevs?.[f];
      if (e.clear && rr !== undefined && rr <= r) {
        delete e.clear.restore[f];
        delete e.clear.restoreRevs![f];
      }
    }
    if (isEmptyEntry(e)) {
      dropSilently(s);
      return lost;
    }
    e.attempts = 0;
    e.nextAt = 0;
    commit(s);
    return lost;
  };
  const raiseError = (s: Slot, message: string) => {
    if (isVisible(s.key)) errors.set(s.key, message);
    else if (!pendingAlerts.includes(s.key)) {
      pendingAlerts.splice(0, pendingAlerts.length);
      pendingAlerts.push(s.key);
      showNextAlert();
    }
  };
  const dropSilently = (s: Slot) => {
    s.mem = null;
    s.incarnation++;
    commit(s);
  };
  const removeIfEmpty = (s: Slot): boolean => {
    if (s.mem && isEmptyEntry(s.mem)) {
      s.mem = null;
      return true;
    }
    return false;
  };

  // Removed DURABLY. After a failed launch read the stored value is still
  // unread: the slot is marked so the read doesn't bring it back.
  const discardNow = (key: string) => {
    const s = slots.get(key);
    if (hydrationFailed && (!s || !s.verified)) {
      const d = s ?? slotFor(key);
      d.discarded = true;
      d.mem = null;
      d.incarnation++;
      commit(d);
      return;
    }
    if (s?.mem) dropSilently(s);
    notify();
  };

  // ── the runner ───────────────────────────────────────────────────────────
  const schedule = (at: number) => {
    if (at >= wakeAt) return;
    if (wakeTimer !== null) deps.clearTimer(wakeTimer);
    wakeAt = at;
    const act = activation;
    wakeTimer = deps.setTimer(() => {
      wakeTimer = null;
      wakeAt = Infinity;
      if (act === activation) pump();
    }, Math.max(0, at - deps.now()));
  };

  // The next op of an entry, in the runner's order: (1) the unresolved op,
  // EXACTLY; (2) the Clear (its base fixed at its FIRST send); (3) one merge
  // of the unsent fields (persisted as the unresolved op before it is sent).
  const nextOp = (s: Slot): { kind: 'merge' | 'clear'; opId: string; body: RateBody; baseVersion: number } | null => {
    const e = s.mem!;
    if (e.baseVersion === 'unknown') return null;
    if (e.unresolvedOp) return { kind: 'merge', opId: e.unresolvedOp.opId, body: e.unresolvedOp.body, baseVersion: e.unresolvedOp.baseVersion };
    if (e.clear) {
      if (e.clear.baseVersion === undefined) {
        e.clear.baseVersion = e.baseVersion;
        commit(s);
      }
      const baseVersion = e.clear.baseVersion;
      return { kind: 'clear', opId: e.clear.opId, baseVersion, body: { wineId: e.wineId, score: 0, flavors: {}, aromas: [], notes: '', opId: e.clear.opId, baseVersion, viewer: `u:${e.viewer}` } };
    }
    if (!hasSendable(e)) return null;
    const revs: Revs = {};
    const body: RateBody = { wineId: e.wineId, merge: true, opId: deps.newOpId(), baseVersion: e.baseVersion, viewer: `u:${e.viewer}` };
    for (const f of unsent(e)) {
      revs[f] = e.fields[f]!.rev;
      (body as Record<string, unknown>)[f] = e.fields[f]!.value;
    }
    e.unresolvedOp = { opId: body.opId!, body, baseVersion: e.baseVersion, revs };
    commit(s);
    return { kind: 'merge', opId: body.opId!, body, baseVersion: e.baseVersion };
  };

  const ownerOk = () => ownerGen !== null && ownerGen === deps.stamp().gen;
  const checkOwner = () => {
    if (viewer === null || ownerChecking) return;
    const gen = deps.stamp().gen;
    if (ownerMismatchGen === gen) return; // held: another account's cookie
    if (ownerNextAt > deps.now()) return schedule(ownerNextAt);
    const act = activation;
    const who = viewer;
    ownerChecking = true;
    const ask = (n: number) => {
      void deps.confirmSession(who).then(
        (check) => answer(check, n),
        () => answer('unknown', n),
      );
    };
    const answer = (check: SessionCheck, n: number) => {
      if (act !== activation || viewer !== who) return;
      if (deps.stamp().gen !== gen) {
        // Moved meanwhile: ask again for the new one, at once the first time,
        // then with the backoff (Fable: a refresh loop can't spin).
        ownerChecking = false;
        ownerMoved++;
        if (ownerMoved >= 2) ownerNextAt = deps.now() + backoffMs(ownerMoved - 1);
        return pump();
      }
      ownerMoved = 0;
      if (check === 'unknown') {
        const retry = () => {
          if (act !== activation || viewer !== who) return;
          ownerRetry = null;
          ask(n + 1);
        };
        const timer = deps.setTimer(retry, backoffMs(n + 1));
        ownerRetry = { timer, ask: () => { deps.clearTimer(timer); retry(); } };
        return;
      }
      ownerChecking = false;
      if (check === 'same') {
        ownerGen = gen;
        ownerMismatchGen = null;
        notify();
        return pump();
      }
      ownerMismatchGen = gen;
      log('[rateOutbox] the session belongs to another account: the queue is held');
      notify();
    };
    ask(0);
  };
  // Every gate the runner checks, again right before a request leaves.
  const eligible = (s: Slot, e: Entry, inc: number, token: number | null): boolean => {
    if (viewer !== e.viewer || !ready || stopped || updateStopped || !online || !ownerOk()) return false;
    if (s.mem !== e || s.incarnation !== inc || !s.verified) return false;
    const t = deps.now();
    if (viewerPauseUntil > t) return false;
    const mp = moment503.get(e.code);
    return !mp || (mp.until <= t && (mp.probe === null || mp.probe === token));
  };

  const pump = () => {
    if (viewer === null || !ready || stopped || updateStopped) return;
    // The owner check first, offline too (it backs off and is asked again at
    // once when the phone is back): the snapshot needs it, not only a send.
    if (!ownerOk()) return checkOwner();
    if (!online) return;
    const t = deps.now();
    if (viewerPauseUntil > t) return schedule(viewerPauseUntil);
    const needRead = new Set<string>();
    for (const s of slots.values()) {
      const e = s.mem;
      if (!e || e.viewer !== viewer || s.inFlight || !s.verified) continue;
      if (e.baseVersion === 'unknown') {
        needRead.add(e.code);
        continue;
      }
      if (!e.unresolvedOp && !e.clear && !hasSendable(e)) continue;
      if (e.nextAt > t) {
        schedule(e.nextAt);
        continue;
      }
      const mp = moment503.get(e.code);
      if (mp) {
        if (mp.until > t) {
          schedule(mp.until);
          continue;
        }
        if (mp.probe !== null) continue;
      }
      const op = nextOp(s);
      if (!op) continue;
      // ONE dispatch of a paused moment probes, holding the token.
      const token = mp ? (mp.probe = ++probeSeq) : null;
      void dispatch(s, op, token);
    }
    for (const code of needRead) void readFor(code);
  };

  const dispatch = async (s: Slot, op: { kind: 'merge' | 'clear'; opId: string; body: RateBody; baseVersion: number }, token: number | null) => {
    const e = s.mem!;
    const act = activation;
    const inc = s.incarnation;
    const cov: Coverage = { entry: e, opId: op.opId, kind: op.kind, revs: op.kind === 'merge' ? { ...(e.unresolvedOp?.revs ?? {}) } : {} };
    s.inFlight = true;
    s.firstAttempt = e.attempts === 0;
    notify();
    // Write-ahead: the op is on disk before it leaves.
    const onDisk = await waitDisk(s);
    // The gate may have closed meanwhile (offline, a stop, a pause, a discard,
    // the owner unconfirmed): the persisted op stays, the slot and its probe
    // are released, the runner resumes later.
    if (act !== activation || !onDisk || !eligible(s, e, inc, token)) {
      s.inFlight = false;
      releaseProbe(e.code, token);
      notify();
      if (act === activation) pump();
      return;
    }
    const stamp = deps.stamp();
    let res: RateResult;
    try {
      res = await deps.send(e.code, op.body, stamp, () => act === activation && eligible(s, e, inc, token));
    } catch (error) {
      res = { kind: 'network', error };
    }
    s.inFlight = false;
    // 🔒 Both stamps rechecked before ANY answer touches the entry.
    if (act !== activation) return; // another viewer: nothing of this one's moves
    if (!deps.stampCurrent(stamp)) {
      // The auth generation moved (a cookie refresh) while it was out: the
      // answer is not applied, and the SAME unresolved op goes out again soon.
      releaseProbe(e.code, token);
      if (inc === s.incarnation && s.mem === e) e.nextAt = deps.now() + STAMP_RETRY_MS;
      notify();
      return pump();
    }
    if (inc !== s.incarnation || s.mem !== e) {
      releaseProbe(e.code, token);
      notify();
      return pump();
    }
    apply(s, op, res, token, cov);
    releaseProbe(e.code, token); // only this dispatch's own answer ends its probe
    notify();
    pump();
  };

  // ── the answer table ─────────────────────────────────────────────────────
  const ack = (e: Entry, revs: Revs) => {
    for (const f of FIELDS) {
      const r = revs[f];
      if (r === undefined) continue;
      e.ackRev[f] = Math.max(e.ackRev[f] ?? 0, r);
      if (e.fields[f] && e.fields[f]!.rev <= e.ackRev[f]!) {
        delete e.fields[f];
        delete e.parked[f];
      }
    }
  };
  const settled = (e: Entry) => {
    e.attempts = 0;
    e.nextAt = 0;
    moment503.delete(e.code);
  };
  const mergeSucceeded = (s: Slot, rating: RatingMeta | null, version: number, opId: string) => {
    const e = s.mem!;
    // The answered op, if it is still the entry's (a retirement may have
    // removed it: its revisions are gone, nothing to acknowledge; never a throw).
    const op = e.unresolvedOp?.opId === opId ? e.unresolvedOp : undefined;
    if (op) delete e.unresolvedOp;
    const canonical = rating ? { ...rating, v: version } : null;
    if (canonical) ownAcked.set(s.key, { v: version, entry: e });
    remember(e.viewer, e.code, e.wineId, canonical);
    deps.patchCache(e.viewer, e.code, e.wineId, canonical);
    if (op) ack(e, op.revs);
    e.baseVersion = version;
    e.baseHadRating = canonical !== null;
    e.rebased = false;
    settled(e);
    errors.delete(s.key);
    if (!e.acked) {
      e.acked = true;
      deps.afterFirstAck(e.viewer, e.code);
    }
    if (removeIfEmpty(s)) savedMarks.add(s.key);
    commit(s);
  };
  const clearSucceeded = (s: Slot) => {
    const e = s.mem!;
    ownAcked.delete(s.key);
    remember(e.viewer, e.code, e.wineId, null);
    deps.patchCache(e.viewer, e.code, e.wineId, null);
    clearGens.set(s.key, (clearGens.get(s.key) ?? 0) + 1);
    settled(e);
    errors.delete(s.key);
    s.mem = null;
    commit(s);
  };
  // A stale Clear is NEVER rebased: it may only delete what the person saw.
  const clearSuperseded = (s: Slot, rating: RatingMeta | null, version: number) => {
    const e = s.mem!;
    const newer = rating ? { ...rating, v: version } : null;
    remember(e.viewer, e.code, e.wineId, newer);
    deps.patchCache(e.viewer, e.code, e.wineId, newer);
    if (isVisible(s.key)) clearAsks.add(s.key);
    s.mem = null;
    commit(s);
  };

  const apply = (s: Slot, op: { kind: 'merge' | 'clear'; opId: string; body: RateBody; baseVersion: number }, res: RateResult, token: number | null, cov: Coverage) => {
    const e = s.mem!;
    const isClear = op.kind === 'clear';
    // A 2xx or a 409 from the moment ends its pause (any request's).
    if (res.kind === 'rating' || res.kind === 'unchanged' || res.kind === 'ok' || res.kind === 'stale') moment503.delete(e.code);
    switch (res.kind) {
      case 'rating':
        if (isClear) return clearSucceeded(s);
        return mergeSucceeded(s, res.rating, res.rating.v ?? 0, op.opId);
      case 'unchanged': {
        if (isClear) return clearSucceeded(s);
        const revs = e.unresolvedOp!.revs;
        delete e.unresolvedOp;
        for (const f of FIELDS) if (revs[f] !== undefined && e.fields[f]?.rev === revs[f]) e.parked[f] = revs[f];
        settled(e);
        removeIfEmpty(s);
        return commit(s);
      }
      case 'ok':
        if (isClear) return clearSucceeded(s);
        // A merge answered without its canonical rating: re-send the same op
        // (the version check answers a committed one with its own lastOpId).
        return ambiguous(s);
      case 'stale': {
        if (res.lastOpId === op.opId) {
          if (isClear) return clearSucceeded(s);
          return mergeSucceeded(s, res.rating, res.version, op.opId);
        }
        // "Not rated" seen, no rating now (a re-rate after a Clear, here or on
        // the web, or after the host deleted it): not a conflict.
        if (res.rating === null && op.baseVersion === 0 && e.baseHadRating === false) {
          if (isClear) return clearSucceeded(s);
          delete e.unresolvedOp;
          e.baseVersion = res.version;
          settled(e);
          return commit(s);
        }
        if (isClear) return clearSuperseded(s, res.rating, res.version);
        if (e.clear) {
          delete e.unresolvedOp;
          return clearSuperseded(s, res.rating, res.version);
        }
        const newer = res.rating ? { ...res.rating, v: res.version } : null;
        remember(e.viewer, e.code, e.wineId, newer);
        deps.patchCache(e.viewer, e.code, e.wineId, newer);
        if (e.waited) return dropSilently(s); // newer rating wins
        if (!e.rebased) {
          delete e.unresolvedOp;
          e.baseVersion = res.version;
          e.baseHadRating = newer !== null;
          e.rebased = true;
          foreign.set(s.key, (foreign.get(s.key) ?? 0) + 1); // a Clear token taken before it asks again
          settled(e);
          return commit(s);
        }
        return dropWithError(s, SAVE_ERROR_TEXT);
      }
      case 'error': {
        const st = res.status;
        if (st === 404 || st === 403 || (st === 401 && res.auth === 'removed')) {
          retireOp(s, cov);
          return;
        }
        // "same" from get-session: the moment refused X; only X retires.
        if (st === 401) return confirmInvalid([s], true, 0, undefined, (x) => void retireOp(x, cov));
        if (st === 400) {
          // Never the note (or any value): the op id, which fields, the message.
          log('[rateOutbox] 400 from /rate (a client bug)', { opId: op.opId, fields: FIELDS.filter((f) => f in op.body), message: res.message });
          if (isClear) {
            const restore = e.clear!.restore;
            delete e.clear;
            for (const f of FIELDS) {
              const v = restore[f];
              if (v !== undefined) (e.fields as Record<string, unknown>)[f] = { value: v, rev: ++e.nextRev };
            }
            settled(e);
            removeIfEmpty(s);
            commit(s);
            if (isVisible(s.key)) errors.set(s.key, SAVE_ERROR_TEXT);
            else {
              pendingAlerts.push(s.key);
              showNextAlert();
            }
            return;
          }
          // The log above is always written; the error only for a lost revision.
          if (retireOp(s, cov)) raiseError(s, SAVE_ERROR_TEXT);
          return;
        }
        if (st === 429) {
          const until = deps.now() + (res.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
          viewerPauseUntil = Math.max(viewerPauseUntil, until);
          e.nextAt = until;
          return commit(s);
        }
        if (st === 503) {
          const t = deps.now();
          const mp = moment503.get(e.code);
          // Only the probe's own 503 (or the first one) moves the backoff: the
          // rest of a burst already wait, and a probe in flight keeps its token.
          if (!mp || (mp.until <= t && (mp.probe === null || mp.probe === token))) {
            const backoff = mp ? Math.min(mp.backoff * 2, BACKOFF_CAP_MS) : BACKOFF_FIRST_MS;
            moment503.set(e.code, { until: t + Math.max(res.retryAfterMs ?? 0, backoff), backoff, probe: mp?.probe ?? null });
          }
          e.nextAt = moment503.get(e.code)!.until;
          return commit(s);
        }
        return ambiguous(s);
      }
      case 'wrong-viewer':
        // The cookie isn't this viewer's: like a 401 `invalid`, stop, keep
        // everything, ask get-session. The entry is NOT dropped on "same" (the
        // moment never refused it); it backs off so a repeat can't spin.
        ownerGen = null;
        e.attempts++;
        e.nextAt = deps.now() + backoffMs(e.attempts);
        commit(s);
        return confirmInvalid([s], false);
      case 'update-required':
        updateStopped = true;
        return;
      case 'cancelled':
        if (res.reason === 'signed-out') stopped = true;
        else if (res.reason === 'stale') e.nextAt = deps.now() + STAMP_RETRY_MS;
        // 'ineligible': released as it is; the runner resumes when the gate opens.
        return;
      case 'network':
      default:
        return ambiguous(s);
    }
  };
  // Not resolved, AMBIGUOUS (it may have committed): back off, the SAME op.
  const ambiguous = (s: Slot) => {
    const e = s.mem!;
    e.attempts++;
    e.nextAt = deps.now() + backoffMs(e.attempts);
    if (unsent(e).length > 0 && !online) e.waited = true;
    commit(s);
  };
  // 401 `invalid`: not definitive on its own (an expired or revoked sign-in
  // answers the same). Stop, keep everything, ask get-session once.
  // `stillCovered`: the dedicated read's coverage, rechecked right before each
  // deletion (Codex recheck 5: an edit or a base since then is resumed, never dropped).
  // `onSame`: what "same" does to a refused slot instead of dropping it (a
  // /rate refusal retires only its own op).
  const confirmInvalid = (refused: Slot[], dropOnSame = true, attempt = 0, stillCovered?: (s: Slot) => boolean, onSame?: (s: Slot) => void) => {
    const items = refused.map((s) => ({ s, inc: s.incarnation, dropOnSame, stillCovered, onSame }));
    stopped = true;
    notify();
    // 🔒 ONE account check in flight per viewer (Codex recheck 7 + 8). Each
    // ask covers only the refusals that arrived BEFORE it started (an answer
    // sampled earlier can't vouch for a later 401); a refusal arriving during
    // an ask waits for a FRESH ask after it. Dispatch stays stopped until
    // every check has settled, and each one's retirements are applied first.
    if (invalidCheck && invalidCheck.act === activation && invalidCheck.who === viewer) {
      invalidCheck.queued.push(...items);
      return;
    }
    if (invalidRetry) {
      deps.clearTimer(invalidRetry.timer);
      invalidRetry = null;
    }
    const check: NonNullable<typeof invalidCheck> = { act: activation, who: viewer!, items: [], queued: items };
    invalidCheck = check;
    const ask = (n: number) => {
      check.items.push(...check.queued); // what this ask covers
      check.queued = [];
      void deps.confirmSession(check.who).then(
        (res) => answer(res, n),
        () => answer('unknown', n),
      );
    };
    const answer = (res: SessionCheck, n: number) => {
      // A viewer change or sign-out ends the retries.
      if (invalidCheck !== check || check.act !== activation || viewer !== check.who) return;
      // No answer: ask again with the runner's backoff while this viewer is
      // signed in. Signed out / another viewer: kept, the runner starts again
      // at that viewer's next sign-in.
      if (res === 'unknown') {
        const retry = () => {
          if (invalidCheck !== check || check.act !== activation || viewer !== check.who) return;
          invalidRetry = null;
          ask(n + 1);
        };
        const timer = deps.setTimer(retry, backoffMs(n + 1));
        invalidRetry = { timer, ask: () => { deps.clearTimer(timer); retry(); } };
        return;
      }
      if (res !== 'same') {
        invalidCheck = null; // stopped, everything kept, until the next sign-in
        return;
      }
      // Still this viewer: a 401 means that moment refused it (left, no longer
      // a member); a wrong-viewer answer refused only the cookie it came with.
      for (const it of check.items) {
        if (!it.dropOnSame || !it.s.mem || it.inc !== it.s.incarnation) continue;
        if (it.onSame) it.onSame(it.s);
        else if (!it.stillCovered || it.stillCovered(it.s)) dropSilently(it.s);
      }
      ownerGen = deps.stamp().gen;
      ownerMismatchGen = null;
      check.items = [];
      // Refusals that arrived during this ask: a fresh ask, still stopped.
      if (check.queued.length) return ask(0);
      invalidCheck = null;
      stopped = false;
      pump();
    };
    ask(attempt);
  };

  // An exact /state read for a moment whose entries have no base yet.
  const readFor = async (code: string) => {
    const v = viewer!;
    const act = activation;
    const r = reads.get(code) ?? { inFlight: false, nextAt: 0, attempts: 0 };
    reads.set(code, r);
    const t = deps.now();
    if (r.inFlight) return;
    if (r.nextAt > t) return schedule(r.nextAt);
    r.inFlight = true;
    const stamp = deps.stamp();
    // The entries this lookup covers, as they are NOW (Codex recheck 4): its
    // answer applies only to those still unchanged when it lands.
    const captured = [...slots.values()]
      .filter((s) => s.mem && s.mem.viewer === v && s.mem.code === code && s.mem.baseVersion === 'unknown')
      .map((s) => ({ s, e: s.mem!, rev: s.mem!.nextRev, at: s.mem!.editedAt, clear: !!s.mem!.clear }));
    let out: ReadOutcome;
    try {
      out = await deps.readState(v, code, stamp);
    } catch {
      out = { kind: 'retry' };
    }
    r.inFlight = false;
    if (act !== activation || viewer !== v) return;
    // Answered under another auth state, or an unconfirmed owner: dropped
    // whole (no base, no terminal outcome, no discard); read again.
    if (!deps.stampCurrent(stamp) || !ownerOk()) return pump();
    const unchanged = (c: (typeof captured)[number]) =>
      c.s.mem === c.e && c.e.baseVersion === 'unknown' && c.e.nextRev === c.rev && c.e.editedAt === c.at && !!c.e.clear === c.clear;
    const covered = captured.filter(unchanged).map((c) => c.s);
    // The dedicated read supplies BASES only: it never moves the snapshot
    // (no raw generation, Codex recheck 3 + 4); work staged since it left is
    // read again (the runner).
    if (out.kind === 'ok' && out.ratings) {
      r.attempts = 0;
      reads.delete(code);
      adoptBases(v, code, out.ratings, new Set(covered));
      notify();
      return pump();
    }
    if (out.kind === 'gone' || out.kind === 'removed') {
      reads.delete(code);
      for (const s of covered) dropSilently(s);
      notify();
      return pump();
    }
    if (out.kind === 'invalid') {
      // Nothing it covered is left: later work gets a fresh lookup.
      if (!covered.length) return pump();
      const byS = new Map(captured.map((c) => [c.s, c]));
      return confirmInvalid(covered, true, 0, (s) => {
        const c = byS.get(s);
        return !!c && unchanged(c);
      });
    }
    if (out.kind === 'update-required') {
      updateStopped = true;
      return;
    }
    r.attempts++;
    r.nextAt = deps.now() + backoffMs(r.attempts);
    schedule(r.nextAt);
  };

  // A RAW ratings section of a moment arrived (a fetch, never our own patch):
  // it supersedes the remembered answers taken before it, and gives the
  // entries without a base theirs. A poll never moves a KNOWN base.
  // `gen`: the auth generation the fetch started under; another one's section
  // supersedes nothing and gives no base.
  const onRawSection = (v: string, code: string, ratings: RatingsView, gen: number) => {
    if (v !== viewer || gen !== deps.stamp().gen) return;
    rawGen.set(vcOf(v, code), (rawGen.get(vcOf(v, code)) ?? 0) + 1);
    // A base from a read only once the credential's owner is confirmed (the
    // runner reads again after the check).
    if (!ownerOk()) {
      notify();
      return pump();
    }
    adoptBases(v, code, ratings);
    notify();
    pump();
  };
  // The base-less entries of a moment take theirs from a ratings section
  // (`only`: the dedicated read's covered entries). A KNOWN base never moves.
  const adoptBases = (v: string, code: string, ratings: RatingsView, only?: Set<Slot>) => {
    for (const s of slots.values()) {
      const e = s.mem;
      if (!e || e.viewer !== v || e.code !== code || e.baseVersion !== 'unknown') continue;
      if (only && !only.has(s)) continue;
      const row = ratings[`u:${v}`]?.ratings[e.wineId];
      if (!row) {
        e.baseVersion = 0;
        e.baseHadRating = false;
        commit(s);
      } else if (e.waited) dropSilently(s);
      else {
        e.baseVersion = row.v ?? 0;
        e.baseHadRating = true;
        commit(s);
      }
    }
  };

  // ── viewer lifecycle + launch ────────────────────────────────────────────
  const retire = () => {
    activation++;
    if (wakeTimer !== null) deps.clearTimer(wakeTimer);
    wakeTimer = null;
    wakeAt = Infinity;
    for (const s of slots.values()) {
      if (s.writeTimer) deps.clearTimer(s.writeTimer);
      for (const w of s.diskWaiters) {
        if (w.timer !== undefined) deps.clearTimer(w.timer);
        w.resolve(false); // waiters resolved as cancelled
      }
    }
    slots.clear();
    hydrationFailed = false;
    ownerGen = null;
    ownerChecking = false;
    ownerMismatchGen = null;
    ownerMoved = 0;
    ownerNextAt = 0;
    ownAcked.clear();
    foreign.clear();
    if (ownerRetry) deps.clearTimer(ownerRetry.timer);
    ownerRetry = null;
    if (invalidRetry) deps.clearTimer(invalidRetry.timer);
    invalidRetry = null;
    invalidCheck = null;
    remembered.clear();
    overlayMemo.clear();
    rawGen.clear();
    clearGens.clear();
    moment503.clear();
    reads.clear();
    savedMarks.clear();
    errors.clear();
    clearAsks.clear();
    pendingAlerts.splice(0, pendingAlerts.length);
    labels.clear();
    alertOpen = false;
    ready = false;
    stopped = false;
    viewerPauseUntil = 0;
  };

  const hydrate = async (v: string, act: number, attempt = 0) => {
    let keys: readonly string[];
    let rows: readonly (readonly [string, string | null])[];
    try {
      keys = (await deps.storage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
      rows = keys.length ? await deps.storage.multiGet(keys) : [];
    } catch (err) {
      if (act !== activation) return;
      log('[rateOutbox] hydration read failed', err);
      if (attempt >= 1) {
        // Accept edits anyway; each key is then read (and merged) before its
        // first write (`loadKey`).
        hydrationFailed = true;
        for (const s of slots.values()) s.verified = false;
        ready = true;
        notify();
        pump(); // the owner check (unverified slots wait for their key reads)
        // Entries still on disk are found by a background DISCOVERY (Codex
        // recheck 9): retried with the runner's backoff until it lists them.
        deps.setTimer(() => { if (act === activation) void discover(v, act, 1); }, backoffMs(1));
        return;
      }
      deps.setTimer(() => { if (act === activation) void hydrate(v, act, attempt + 1); }, WRITE_RETRY_FIRST_MS);
      return;
    }
    if (act !== activation) return;
    const t = deps.now();
    const mine = `${STORAGE_PREFIX}${encodeURIComponent(v)}|`;
    for (const [k, raw] of rows) {
      let e: Entry | null = null;
      try {
        e = raw ? (JSON.parse(raw) as Entry) : null;
      } catch {
        e = null;
      }
      // The 90-day clean-up runs over EVERY viewer's entries (another account's
      // waiting saves on a shared phone), and drops what can't be read.
      if (e && typeof e.editedAt !== 'number') e.editedAt = e.updatedAt;
      if (!e || typeof e.editedAt !== 'number' || t - e.editedAt > CLEANUP_MS) {
        void deps.storage.removeItem(k).catch(() => {});
        continue;
      }
      if (!k.startsWith(mine) || e.viewer !== v) continue;
      const s = slotFor(keyOf(e.viewer, e.code, e.wineId));
      if (s.mem) continue; // staged while hydration was retrying
      e.parked ??= {};
      e.ackRev ??= {};
      e.fields ??= {};
      e.waited = true;
      s.mem = e;
      s.diskV = s.memV;
      commit(s);
    }
    ready = true;
    notify();
    pump();
  };

  // After a failed launch read: list this viewer's stored keys and feed each
  // through the per-key merge (`loadKey`: newer page edits and confirmed
  // discards still win); every other unverified slot is read too (nothing
  // stored → verified). Retried with the runner's backoff until it succeeds or
  // the viewer changes; then new slots are verified from the start.
  const discover = async (v: string, act: number, n: number) => {
    let keys: readonly string[];
    try {
      keys = await deps.storage.getAllKeys();
    } catch (err) {
      if (act !== activation) return;
      log('[rateOutbox] key discovery failed', err);
      deps.setTimer(() => { if (act === activation) void discover(v, act, n + 1); }, backoffMs(n + 1));
      return;
    }
    if (act !== activation || viewer !== v) return;
    const mine = `${STORAGE_PREFIX}${encodeURIComponent(v)}|`;
    for (const k of keys) {
      if (!k.startsWith(mine)) continue;
      const [code, wineId] = k.slice(mine.length).split('|').map(decodeURIComponent);
      if (code === undefined || wineId === undefined) continue;
      slotFor(keyOf(v, code, wineId));
    }
    hydrationFailed = false;
    for (const s of [...slots.values()]) if (!s.verified) void loadKey(s);
    pump();
  };

  const api = {
    // The signed-in viewer (null = signed out). A change retires the previous
    // viewer's in-memory work (its stored entries stay for it); a viewer
    // hydrates its own entries (waited) and starts the runner.
    setViewer(next: string | null) {
      if (next === viewer && (next === null || !stopped)) return;
      retire();
      viewer = next;
      if (next !== null) void hydrate(next, activation);
      notify();
    },
    // clearViewerCache(): timers, waiters, Clear generations, remembered
    // answers. The stored entries stay; the same viewer re-hydrates them.
    retireMemory() {
      const v = viewer;
      retire();
      viewer = v;
      if (v !== null) void hydrate(v, activation);
      notify();
    },
    viewer: () => viewer,
    online: () => online,
    foreignRebases: (v: string, code: string, wineId: string) => foreign.get(keyOf(v, code, wineId)) ?? 0,
    // The entry pending now (a baseline captured now may advance only through its ack).
    pendingMark: (v: string, code: string, wineId: string): EntryMark | null => slots.get(keyOf(v, code, wineId))?.mem ?? null,
    // The entry holds a revision of this field (pending, sent or parked).
    hasRevision(v: string, code: string, wineId: string, field: Field): boolean {
      const e = slots.get(keyOf(v, code, wineId))?.mem;
      return !!e && (!!e.fields[field] || e.unresolvedOp?.revs[field] !== undefined);
    },
    ready: (v: string) => v === viewer && ready,
    setOnline(next: boolean) {
      if (next === online) return;
      online = next;
      // A get-session waiting on its backoff is asked again at once.
      if (next && ownerRetry) ownerRetry.ask();
      if (next && invalidRetry) invalidRetry.ask();
      if (!next) {
        for (const s of slots.values()) {
          if (s.mem && !s.mem.waited && (unsent(s.mem).length > 0 || s.mem.unresolvedOp || s.mem.clear)) {
            s.mem.waited = true;
            commit(s);
          }
        }
      }
      notify();
      pump();
    },
    setAppActive(next: boolean) {
      if (next === appActive) return;
      appActive = next;
      if (next) showNextAlert();
      notify();
    },
    onRawSection,
    // Something the snapshot reads changed (the query cache): re-render.
    // Any query activity: re-render, and re-ask a held owner check once the
    // auth generation has moved (a sign-in lifts the hold without a poll).
    touch: () => {
      notify();
      if (viewer !== null && !ownerOk() && ownerMismatchGen !== deps.stamp().gen) pump();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    version: () => ver,

    snapshot: snapshotOf,
    entry: (v: string, code: string, wineId: string): Readonly<Entry> | null => entryOf(v, code, wineId),
    clearGen: (v: string, code: string, wineId: string) => clearGens.get(keyOf(v, code, wineId)) ?? 0,
    status(v: string, code: string, wineId: string): KeyStatus {
      const key = keyOf(v, code, wineId);
      const s = slots.get(key);
      const e = s?.mem ?? null;
      return {
        ready: v === viewer && ready,
        pending: !!e && (!!e.unresolvedOp || hasSendable(e)),
        clear: !!e?.clear,
        persisted: !s || s.diskV >= s.memV,
        firstAttemptInFlight: !!s?.inFlight && s.firstAttempt,
        saved: savedMarks.has(key),
        error: errors.get(key) ?? (s?.writeFailed ? SAVE_ERROR_TEXT : null),
        baselineReady: snapshotOf(v, code, wineId) !== null,
      };
    },

    // Stage a SETTLED edit (the ~1 s tick, a capture). `value` and `seed` come
    // normalized from the draft (the structure map filled, the aromas gated);
    // `seed` = the snapshot's value (undefined = no snapshot). Equal to the
    // seed with no sent-but-unanswered revision → NOT staged (and removed).
    // `latched`: the baseline (snapshot) and offline provenance taken at the
    // FIRST accepted edit of a clean draft (Codex P1): an entry created now
    // takes ITS base, never the snapshot at staging time.
    stage<F extends Field>(v: string, code: string, wineId: string, field: F, value: FieldValues[F], seed: FieldValues[F] | undefined, latched?: { base: Snapshot; offline: boolean; mark?: EntryMark | null }): boolean {
      if (v !== viewer || !ready) return false;
      const s = slotFor(keyOf(v, code, wineId));
      if (s.mem?.clear) return false;
      // "Unchanged since the seed" only for a field with NO revision in the
      // entry (pending, sent or parked): otherwise the latest value always
      // goes out, even back to the server's (harmless; Codex recheck 3).
      const hasRev = !!s.mem && (!!s.mem.fields[field] || s.mem.unresolvedOp?.revs[field] !== undefined);
      if (seed !== undefined && sameField(field, value, seed) && !hasRev) return true;
      const prior = s.mem?.fields[field];
      if (prior && sameField(field, prior.value, value)) return true;
      if (!s.mem) s.mem = newEntry(v, code, wineId, latched?.base, latched?.mark);
      const e = s.mem;
      if (latched?.offline) e.waited = true;
      (e.fields as Record<string, unknown>)[field] = { value, rev: ++e.nextRev };
      delete e.parked[field];
      if (!online) e.waited = true;
      e.rebased = false;
      e.editedAt = deps.now();
      savedMarks.delete(s.key);
      commit(s);
      pump();
      return true;
    },
    // Resolves true once this wine's entry is on disk (the departure waiter).
    persisted(v: string, code: string, wineId: string, timeoutMs = WAITER_TIMEOUT_MS): Promise<boolean> {
      if (v !== viewer) return Promise.resolve(false);
      const s = slots.get(keyOf(v, code, wineId));
      return s ? waitDisk(s, timeoutMs) : Promise.resolve(true);
    },
    // Clear My Rating (after the confirm): a new op id, NO base yet (fixed at
    // its first send), the current edits kept as the restore snapshot.
    // `opts.base`: the baseline DISPLAYED when the confirm opened (Codex P1: a
    // poll may move the snapshot while the alert is up); with no entry it is
    // the Clear's base, which only its own predecessor's answer can move.
    // `opts.extra`: the page's UNSETTLED fields, kept in the restore snapshot
    // atomically (never sent as a merge of their own).
    // `opts.foreign`: `foreignRebases()` when the confirm opened. An entry
    // rebased onto another writer's save since then → no Clear: the page shows
    // the newer rating and asks again (it may only delete what was seen).
    clear(v: string, code: string, wineId: string, opts: { base?: Snapshot; extra?: Partial<FieldValues>; foreign?: number; mark?: EntryMark | null } = {}): boolean {
      if (v !== viewer || !ready) return false;
      const s = slotFor(keyOf(v, code, wineId));
      if (s.mem?.clear) return true;
      if (opts.foreign !== undefined && (foreign.get(s.key) ?? 0) !== opts.foreign) {
        if (isVisible(s.key)) clearAsks.add(s.key);
        notify();
        return false;
      }
      if (!s.mem) s.mem = newEntry(v, code, wineId, opts.base, opts.mark);
      const e = s.mem;
      const restore: Partial<FieldValues> = {};
      const restoreRevs: Revs = {};
      for (const f of FIELDS) {
        if (!e.fields[f]) continue;
        (restore as Record<string, unknown>)[f] = e.fields[f]!.value;
        restoreRevs[f] = e.fields[f]!.rev;
      }
      for (const f of FIELDS) {
        if (opts.extra?.[f] === undefined) continue;
        (restore as Record<string, unknown>)[f] = opts.extra[f];
        delete restoreRevs[f]; // the page's unsettled value: newer than any op
      }
      e.fields = {};
      e.parked = {};
      e.clear = { opId: deps.newOpId(), restore, restoreRevs };
      e.rebased = false;
      e.editedAt = deps.now();
      if (!online) e.waited = true;
      savedMarks.delete(s.key);
      commit(s);
      pump();
      return true;
    },
    // ONLY a confirmed terminal outcome (a successful Delete Impression, its
    // own answer): removed DURABLY at once, its in-flight answer ignored, its
    // alerts suppressed. What a page merely SAW (the bottle gone from its
    // line-up, a removal) deletes nothing here: the entry goes out and the
    // server's answer decides (404 / 403 / 401 removed drop it, Codex recheck 3).
    discard(v: string, code: string, wineId: string, opts: { confirmed?: boolean } = {}) {
      if (v !== viewer || !opts.confirmed) return;
      const key = keyOf(v, code, wineId);
      const i = pendingAlerts.indexOf(key);
      if (i >= 0) pendingAlerts.splice(i, 1);
      errors.delete(key);
      clearAsks.delete(key);
      discardNow(key);
    },
    // A page of that wine is VISIBLE (mounted, active, focused; the app's
    // foreground is the owner's own).
    setVisible(v: string, code: string, wineId: string, mount: number, on: boolean) {
      const key = keyOf(v, code, wineId);
      const set = visible.get(key) ?? new Set<number>();
      if (on) set.add(mount);
      else set.delete(mount);
      if (set.size) visible.set(key, set);
      else visible.delete(key);
    },
    setLabel(v: string, code: string, wineId: string, label: string | null) {
      if (label) labels.set(keyOf(v, code, wineId), label);
    },
    // The stale-Clear "ask again" for a visible page (consumed once).
    takeClearAsk(v: string, code: string, wineId: string): boolean {
      return clearAsks.delete(keyOf(v, code, wineId));
    },

    // The line-up's own rows: the entry's edits over the own-rating snapshot
    // (the poll's retained view only when there is none); an EMPTY result keeps
    // the underlying rating (emptying by hand never deletes); a pending Clear →
    // no rating. Returns `ratings` itself when nothing is overlaid.
    overlay(v: string, code: string, ratings: RatingsView | null): RatingsView | null {
      if (v !== viewer) return ratings;
      const id = `u:${v}`;
      const wineIds = new Set<string>();
      for (const s of slots.values()) if (s.mem && s.mem.viewer === v && s.mem.code === code) wineIds.add(s.mem.wineId);
      const prefix = `${vcOf(v, code)}\u0001`;
      for (const k of remembered.keys()) if (k.startsWith(prefix)) wineIds.add(k.slice(prefix.length));
      if (wineIds.size === 0) return ratings;
      const group = ratings?.[id];
      const out: Record<string, RatingMeta> = { ...(group?.ratings ?? {}) };
      for (const w of wineIds) {
        const snap = snapshotOf(v, code, w);
        const base = snap ? snap.rating : group?.ratings[w] ?? null;
        const e = entryOf(v, code, w);
        let r: RatingMeta | null = base;
        if (e?.clear) r = null;
        else if (e && Object.keys(e.fields).length) {
          const merged: RatingMeta = {
            score: e.fields.score?.value ?? base?.score ?? 0,
            notes: e.fields.notes ? noteOut(e.fields.notes.value) : base?.notes ?? '',
            flavors: e.fields.flavors?.value ?? base?.flavors ?? {},
            aromas: e.fields.aromas?.value ?? base?.aromas ?? [],
            at: base?.at ?? e.updatedAt,
            ...(base?.v !== undefined ? { v: base.v } : {}),
          };
          r = isEmptyRating(merged) ? base : merged;
        }
        if (r) out[w] = r;
        else delete out[w];
      }
      // The same `ratings` and value-equal own rows → the SAME object (the
      // line-up neither re-sorts nor re-renders its rows for an unrelated
      // owner change or a poll that brought nothing new).
      const vc = vcOf(v, code);
      const sig = stable(out);
      const memo = overlayMemo.get(vc);
      if (memo && memo.ratings === ratings && memo.sig === sig) return memo.result;
      const result = { ...(ratings ?? {}), [id]: { displayName: group?.displayName ?? '', ratings: out } };
      overlayMemo.set(vc, { ratings, sig, result });
      return result;
    },

    // Tests and diagnostics.
    _debug: () => ({ activation, stopped, ownerGen, ownerMismatchGen, updateStopped, viewerPauseUntil, online, moment503: new Map(moment503), slots: [...slots.values()].map((s) => ({ key: s.key, mem: s.mem, memV: s.memV, diskV: s.diskV, inFlight: s.inFlight })) }),
  };
  return api;
}
