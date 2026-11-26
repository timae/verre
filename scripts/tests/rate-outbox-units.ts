// Behavioural pins for the rating auto-save (tasting-feedback build 1 § 1):
// the PRODUCTION outbox owner + runner (apps/mobile/src/lib/rateOutboxCore.ts)
// and the impression draft controller (impressionAutosaveCore.ts), driven with
// injected storage, clock, network, auth and fetch, against a fake /rate that
// implements the version check, the merge, `unchanged` and the reap the way
// § 1b specifies them. No React Native, no network.
//
//   npx tsx scripts/tests/rate-outbox-units.ts

import { resolveAxes, scrub } from '@verre/core';
import type { RateBody, RateResult, RatingMeta, RatingsView } from '../../apps/mobile/src/lib/api/rateTypes';
import {
  ALERT_TITLE, CLEANUP_MS, SAVE_ERROR_TEXT, STORAGE_PREFIX, backoffMs, createRateOutbox, isEmptyRating, storageKey,
  type OutboxDeps, type ReadOutcome, type SessionCheck,
} from '../../apps/mobile/src/lib/rateOutboxCore';
import { createAutosaveController, createTransitionGuard } from '../../apps/mobile/src/lib/impressionAutosaveCore';

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const AXES = resolveAxes('wine', null).map((a) => a.k);
const A0 = AXES[0];
const ME = 'pubMe0000001';
const CODE = 'ABCD2345';
const ID = `u:${ME}`;
let opSeq = 0; // one sequence across relaunches (real op ids are UUIDs)

// ── a fake server: one rating per wine for ME ─────────────────────────────
type ServerRow = { rating: RatingMeta | null; version: number; lastOpId: string | null };
type Mode = 'auto' | 'hang' | 'network' | 'commit-network' | 'update' | { status: number; retryAfterMs?: number; auth?: 'removed' | 'invalid'; message?: string };

function fakeServer(now: () => number) {
  const rows = new Map<string, ServerRow>();
  const row = (w: string) => rows.get(w) ?? { rating: null, version: 0, lastOpId: null };
  const empty = (r: { score: number; flavors: Record<string, number>; aromas?: unknown[]; notes: string }) => isEmptyRating(r);
  let beforeCommit: ((b: RateBody) => void) | null = null;
  const commit = (b: RateBody): RateResult => {
    beforeCommit?.(b);
    const cur = row(b.wineId);
    if (b.baseVersion !== undefined && b.baseVersion !== cur.version) {
      return { kind: 'stale', status: 409, rating: cur.rating ? { ...cur.rating, v: cur.version } : null, version: cur.version, lastOpId: cur.lastOpId };
    }
    const prev = cur.rating;
    if (b.merge) {
      const merged = {
        score: b.score ?? prev?.score ?? 0,
        flavors: b.flavors ?? prev?.flavors ?? {},
        aromas: b.aromas ?? prev?.aromas ?? [],
        notes: b.notes !== undefined ? scrub(b.notes) ?? '' : prev?.notes ?? '',
      };
      if (empty(merged)) return { kind: 'unchanged', status: 200 };
      const version = cur.version + 1;
      const rating = { ...merged, at: now(), v: version };
      rows.set(b.wineId, { rating, version, lastOpId: b.opId ?? null });
      return { kind: 'rating', status: 200, rating };
    }
    const full = { score: b.score ?? 0, flavors: b.flavors ?? {}, aromas: b.aromas ?? [], notes: scrub(b.notes ?? '') ?? '' };
    const version = cur.version + 1;
    rows.set(b.wineId, { rating: empty(full) ? null : { ...full, at: now(), v: version }, version, lastOpId: b.opId ?? null });
    return { kind: 'ok', status: 200 };
  };
  return {
    rows,
    row,
    commit,
    // A write from elsewhere that lands right before each of ours.
    set beforeCommit(f: ((b: RateBody) => void) | null) { beforeCommit = f; },
    // Another device (the web): no base, still bumps.
    webSave(w: string, r: Partial<RatingMeta>) {
      const cur = row(w);
      const version = cur.version + 1;
      rows.set(w, { rating: { score: 0, flavors: {}, notes: '', aromas: [], at: now(), ...r, v: version }, version, lastOpId: null });
    },
    webReset(w: string) {
      const cur = row(w);
      rows.set(w, { rating: null, version: cur.version + 1, lastOpId: null });
    },
    // A rating from before the release: a row, no version.
    legacy(w: string, r: Partial<RatingMeta>) {
      rows.set(w, { rating: { score: 0, flavors: {}, notes: '', aromas: [], at: now(), ...r }, version: 0, lastOpId: null });
    },
    section(): RatingsView {
      const ratings: Record<string, RatingMeta> = {};
      for (const [w, r] of rows) if (r.rating) ratings[w] = { ...r.rating, ...(r.version ? { v: r.version } : {}) };
      return { [ID]: { displayName: 'Me', ratings } };
    },
  };
}

// ── the environment ────────────────────────────────────────────────────────
function env(opts: { disk?: Map<string, string>; t0?: number; online?: boolean } = {}) {
  let t = opts.t0 ?? 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let tid = 0;
  const disk = opts.disk ?? new Map<string, string>();
  let failWrites = false;
  let holdWrites = false;
  const heldWrites: (() => void)[] = [];
  let cookieOf = `u:${ME}`; // whose cookie the fake server sees
  let holdReads = false;
  const heldReads: (() => void)[] = [];
  let holdCookie = false; // the binding's async cookie read, before its beforeSend
  const heldCookies: (() => void)[] = [];
  let sendCalls = 0;
  let confirms = 0;
  let failKeys = false;
  let failGet = 0; // the next N multiGet calls fail
  const logs: { m: string; d: unknown }[] = [];
  const sessionQueue: SessionCheck[] = [];
  let online = opts.online ?? true;
  let active = true;
  let epoch = 0;
  let gen = 0;
  let signedIn = true;
  const server = fakeServer(() => t);
  const sent: { body: RateBody; at: number }[] = [];
  const reads: number[] = [];
  const alerts: string[] = [];
  let mode: Mode = 'auto';
  const modeQueue: Mode[] = [];
  // A hung request: released by committing, or failed with `res` (releaseOne).
  const hung: ((res?: RateResult) => void)[] = [];
  let bumpOnConfirm = 0; // get-session answers that each move the auth generation
  // `gen`: the auth generation the section's fetch started under (the binding's stamp).
  const cache = new Map<string, { ratings: RatingsView | null; gen?: number; wines?: { id: string; name: string; _blind?: boolean }[] }>();
  let readAnswer: (() => ReadOutcome) | null = null;
  let session: SessionCheck = 'same';

  const transport = (code: string, body: RateBody, stillEligible: () => boolean): Promise<RateResult> => {
    if (!signedIn) return Promise.resolve({ kind: 'cancelled', reason: 'signed-out' } as RateResult);
    // The binding's beforeSend: the gate checked again right before sending.
    if (!stillEligible()) return Promise.resolve({ kind: 'cancelled', reason: 'ineligible' } as RateResult);
    sent.push({ body: JSON.parse(JSON.stringify(body)), at: t });
    if (body.viewer !== cookieOf) return Promise.resolve({ kind: 'wrong-viewer', status: 409 } as RateResult);
    const m = modeQueue.length ? modeQueue.shift()! : mode;
    if (m === 'hang') {
      return new Promise<RateResult>((resolve) => hung.push((res?: RateResult) => resolve(res ?? server.commit(body))));
    }
    if (m === 'network') return Promise.resolve({ kind: 'network', error: new Error('offline') } as RateResult);
    if (m === 'update') return Promise.resolve({ kind: 'update-required' } as RateResult);
    if (m === 'commit-network') {
      server.commit(body);
      return Promise.resolve({ kind: 'network', error: new Error('lost') } as RateResult);
    }
    if (typeof m === 'object') return Promise.resolve({ kind: 'error', status: m.status, retryAfterMs: m.retryAfterMs ?? null, auth: m.auth ?? null, message: m.message ?? null } as RateResult);
    return Promise.resolve(server.commit(body));
  };
  const deps: OutboxDeps = {
    storage: {
      getAllKeys: async () => {
        if (failKeys) throw new Error('storage unreadable');
        return [...disk.keys()];
      },
      multiGet: async (keys) => {
        if (failGet > 0) {
          failGet--;
          throw new Error('storage unreadable');
        }
        return keys.map((k) => [k, disk.get(k) ?? null] as const);
      },
      setItem: async (k, v) => {
        if (failWrites) throw new Error('disk full');
        if (holdWrites) await new Promise<void>((r) => heldWrites.push(r));
        disk.set(k, v);
      },
      removeItem: async (k) => {
        if (failWrites) throw new Error('disk full');
        disk.delete(k);
      },
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++tid;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    isOnline: () => online,
    appActive: () => active,
    newOpId: () => `00000000-0000-4000-8000-${String(++opSeq).padStart(12, '0')}`,
    stamp: () => ({ epoch, gen }),
    stampCurrent: (s) => s.epoch === epoch && s.gen === gen,
    send: (code, body, _stamp, stillEligible) => {
      sendCalls++;
      // Synchronous unless the cookie read is held (the old pins' timing).
      if (holdCookie) return new Promise<void>((r) => heldCookies.push(r)).then(() => transport(code, body, stillEligible));
      return transport(code, body, stillEligible);
    },
    readState: async () => {
      reads.push(t);
      if (holdReads) await new Promise<void>((r) => heldReads.push(r));
      const out = readAnswer ? readAnswer() : { kind: 'ok' as const, ratings: server.section() };
      return out;
    },
    confirmSession: async () => {
      confirms++;
      if (bumpOnConfirm > 0) {
        bumpOnConfirm--;
        gen++;
      }
      return sessionQueue.length ? sessionQueue.shift()! : session;
    },
    readRatings: (_v, code) => {
      const c = cache.get(code);
      return c && 'ratings' in c ? { ratings: c.ratings, gen: c.gen ?? -1 } : undefined;
    },
    patchCache: (_v, code, wineId, rating) => {
      const c = cache.get(code);
      const g = c?.ratings?.[ID];
      if (!c || !c.ratings || !g) return;
      const r = { ...g.ratings };
      if (rating) r[wineId] = rating;
      else delete r[wineId];
      c.ratings = { ...c.ratings, [ID]: { ...g, ratings: r } };
    },
    afterFirstAck: () => {},
    alert: (title, message, done) => {
      alerts.push(`${title}: ${message}`);
      done();
    },
    label: (_v, code, wineId) => cache.get(code)?.wines?.find((w) => w.id === wineId)?.name ?? null,
    log: (m, d) => logs.push({ m, d }),
  };
  const owner = createRateOutbox(deps);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms: number) => {
    const target = t + ms;
    await flush();
    // A runaway (a timer re-arming at the same instant) fails, never hangs CI.
    for (let fired = 0; ; fired++) {
      if (fired > 100_000) throw new Error('runaway timers in advance()');
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      t = next.at;
      next.fn();
      await flush();
    }
    t = target;
    await flush();
  };
  const ctl = (wineId: string, kind: null | { sparkling: boolean } = null) =>
    createAutosaveController(owner, { viewer: ME, code: CODE, wineId, kind, timers: { set: deps.setTimer, clear: deps.clearTimer } });
  // The line-up poll / a fresh /state read: a RAW section into the cache.
  // `fetchedGen`: the generation its fetch started under (default: now).
  const poll = (ratings: RatingsView | null = server.section(), fetchedGen = gen) => {
    cache.set(CODE, { ...(cache.get(CODE) ?? {}), ratings, gen: fetchedGen });
    if (ratings) owner.onRawSection(ME, CODE, ratings, fetchedGen);
  };
  return {
    owner, server, disk, sent, reads, alerts, cache, ctl, poll, flush, advance, logs,
    bumpGen: () => { gen++; },
    genNow: () => gen,
    bumpOnConfirm: (n: number) => { bumpOnConfirm = n; },
    // The OLDEST hung request answers `res` (a network error, …) without committing.
    releaseOne: async (res: RateResult) => { hung.shift()!(res); await flush(); },
    get confirms() { return confirms; },
    cookieAs: (who: string) => { cookieOf = who; },
    holdWrites: (on: boolean) => { holdWrites = on; },
    get sendCalls() { return sendCalls; },
    holdReads: (on: boolean) => { holdReads = on; },
    releaseReads: async () => { holdReads = false; while (heldReads.length) heldReads.shift()!(); await flush(); },
    holdCookie: (on: boolean) => { holdCookie = on; },
    releaseCookie: async () => { holdCookie = false; while (heldCookies.length) heldCookies.shift()!(); await flush(); },
    releaseWrites: async () => { holdWrites = false; while (heldWrites.length) heldWrites.shift()!(); await flush(); },
    failReads: (keys: boolean, gets = 0) => { failKeys = keys; failGet = gets; },
    sessions: (...q: SessionCheck[]) => sessionQueue.push(...q),
    get t() { return t; },
    set mode(m: Mode) { mode = m; },
    queue: (...m: Mode[]) => modeQueue.push(...m),
    release: async () => { while (hung.length) hung.shift()!(); await flush(); },
    setOnline: async (on: boolean) => { online = on; owner.setOnline(on); await flush(); },
    setActive: (on: boolean) => { active = on; owner.setAppActive(on); },
    failWrites: (on: boolean) => { failWrites = on; },
    signOut: () => { signedIn = false; epoch++; gen++; owner.setViewer(null); },
    signIn: async () => { signedIn = true; gen++; owner.setViewer(ME); await flush(); },
    setSession: (s: SessionCheck) => { session = s; },
    setRead: (f: (() => ReadOutcome) | null) => { readAnswer = f; },
    start: async () => { owner.setViewer(ME); await flush(); },
  };
}
type Env = ReturnType<typeof env>;
const relaunch = async (e: Env, o: { online?: boolean; before?: (n: Env) => void } = {}) => {
  const n = env({ disk: e.disk, t0: e.t, online: o.online ?? true });
  for (const [w, r] of e.server.rows) n.server.rows.set(w, r);
  o.before?.(n);
  await n.start();
  return n;
};
const lastBody = (e: Env) => e.sent[e.sent.length - 1]?.body;

async function main() {
  // ── only changed fields are sent ─────────────────────────────────────────
  {
    const e = env();
    e.server.webSave('w1', { score: 3, notes: 'fresh', flavors: { [A0]: 2 } });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    check('seeded from the snapshot: score, note, structure', c.draft().score === 3 && c.draft().notes === 'fresh' && c.draft().flavors[A0] === 2);
    c.setNotes('fresher');
    await e.advance(999);
    check('nothing staged before the input settles (~1 s)', e.sent.length === 0);
    await e.advance(1);
    const b = lastBody(e);
    check('one MERGE with only the note, on the version seen', e.sent.length === 1 && b?.merge === true && b.notes === 'fresher' && b.score === undefined && b.flavors === undefined && b.aromas === undefined && b.baseVersion === 1, b);
    check('answered → "Saved", the entry gone, nothing waiting on disk', c.savedState() === 'saved' && e.owner.entry(ME, CODE, 'w1') === null && e.disk.size === 0);
  }

  // ── an edit before the seed keeps the edit; relative edits wait ──────────
  {
    const e = env();
    e.server.webSave('w1', { score: 2, notes: 'stored', flavors: { [A0]: 3 } });
    await e.start();
    const c = e.ctl('w1');
    check('no snapshot yet: baselineReady false', !c.baselineReady());
    c.setFlavors({ [A0]: 5 });
    c.stepScore(0.25);
    c.setAromas([{ a: 'fruity', m: null }]);
    check('relative edits (structure, VoiceOver step, aroma add) are inert before the baseline', c.draft().flavors[A0] === undefined && c.draft().score === 0 && c.draft().aromas.length === 0);
    c.setScore(4);
    e.poll();
    check('an absolute edit before the seed keeps the edit; clean fields seed from the late snapshot', c.draft().score === 4 && c.draft().notes === 'stored' && c.draft().flavors[A0] === 3);
    c.setFlavors({ [A0]: 4 });
    check('after the baseline a relative edit lands', c.draft().flavors[A0] === 4);
  }

  // ── the note keeps its raw text while focused ────────────────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setNoteFocused(true);
    c.setNotes('dry ');
    await e.advance(1000);
    check('"dry " saved, answered with the canonical "dry"', e.server.row('w1').rating?.notes === 'dry' && c.savedState() === 'saved');
    check('focused: the field keeps "dry " (no reseed under the cursor)', c.draft().notes === 'dry ');
    c.setNotes('dry oak');
    await e.advance(1000);
    check('"oak" typed after Saved → "dry oak", never "dryoak"', e.server.row('w1').rating?.notes === 'dry oak', e.server.row('w1').rating?.notes);
    c.setNoteFocused(false);
    check('blur: the canonical text takes over', c.draft().notes === 'dry oak');
  }

  // ── the base is fixed at creation and persisted ──────────────────────────
  {
    const e = env({ online: false });
    e.server.webSave('w1', { score: 3 });
    e.server.webSave('w1', { score: 3 });
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4.5);
    await e.advance(1000);
    check('offline: nothing sent, "Saved on this phone"', e.sent.length === 0 && c.savedState() === 'local');
    const stored = JSON.parse(e.disk.get(storageKey(ME, CODE, 'w1'))!);
    check('the entry on disk carries base 3 (the version the edit was based on)', stored.baseVersion === 3 && stored.baseHadRating === true);
    const n = await relaunch(e); // killed; relaunched online with an EMPTY cache
    await n.advance(10);
    check('relaunch: the stored base goes out and commits', n.sent.length === 1 && n.sent[0].body.baseVersion === 3 && n.server.row('w1').rating?.score === 4.5);
  }
  {
    const e = env({ online: false });
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    e.ctl('w1').setScore(1);
    await e.advance(1000);
    e.server.webSave('w1', { score: 5 }); // a web save meanwhile
    const n = await relaunch(e);
    await n.advance(10);
    check('a web save in between → 409 → the WAITED entry is dropped (newer rating wins), no alert', n.sent.length === 1 && n.server.row('w1').rating?.score === 5 && n.owner.entry(ME, CODE, 'w1') === null && n.alerts.length === 0);
  }

  // ── a live edit meets a newer write: one rebase ──────────────────────────
  {
    const e = env();
    e.server.webSave('w1', { score: 3, notes: 'a' });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    e.server.webSave('w1', { score: 3, notes: 'from the web' });
    c.setScore(4);
    await e.advance(1000);
    await e.advance(10);
    check('live: 409 → ONE rebase → saved, the clean note re-seeded from the newer rating', e.sent.length === 2 && e.server.row('w1').rating?.score === 4 && e.server.row('w1').rating?.notes === 'from the web' && c.draft().notes === 'from the web');
    const sentBefore = e.sent.length;
    e.server.beforeCommit = (b) => { if (b.wineId === 'w1') e.server.webSave('w1', { score: 1 }); };
    c.setScore(4.25);
    await e.advance(1000);
    await e.advance(10);
    e.server.beforeCommit = null;
    check('a second 409 in a row for the same edits → dropped with the footer error (page visible: no alert)', e.sent.length === sentBefore + 2 && e.owner.entry(ME, CODE, 'w1') === null && c.savedState() === 'error' && e.alerts.length === 0, { sent: e.sent.length - sentBefore, s: c.savedState() });
  }
  {
    const e = env();
    e.server.webSave('w2', { score: 3 });
    e.poll();
    e.cache.get(CODE)!.wines = [{ id: 'w2', name: 'Riesling' }];
    await e.start();
    const c = e.ctl('w2');
    e.owner.setVisible(ME, CODE, 'w2', 7, false); // a hidden neighbour (mounted, not visible)
    e.server.beforeCommit = (b) => { if (b.wineId === 'w2') e.server.webSave('w2', { score: 1 }); };
    c.setScore(4);
    await e.advance(1000);
    await e.advance(10);
    check('a drop while the page is a hidden neighbour → the after-leave alert, once', e.alerts.length === 1 && e.alerts[0] === `${ALERT_TITLE}: Your last changes to Riesling couldn’t be saved.`, e.alerts);
  }

  // ── an ambiguous answer whose op had committed ───────────────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    e.queue('commit-network');
    c.setScore(4);
    await e.advance(1000);
    check('ambiguous (committed, answer lost) → "Saved on this phone" while it retries', c.savedState() === 'local');
    await e.advance(5000);
    const [a, b] = e.sent;
    check('re-sent with the SAME op id → 409 with its own lastOpId → adopted', e.sent.length === 2 && a.body.opId === b.body.opId && c.savedState() === 'saved' && e.server.row('w1').version === 1);
  }

  // ── an unknown base: no request until a raw section arrives ──────────────
  {
    const e = env();
    await e.start();
    e.setRead(() => ({ kind: 'ok', ratings: null }));
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(1000);
    check('unknown base: no /rate, ONE /state read', e.sent.length === 0 && e.reads.length === 1);
    await e.advance(4000);
    check('a null section retries with the runner backoff (not before 5 s)', e.reads.length === 1);
    await e.advance(1000);
    check('… then reads again', e.reads.length === 2);
    e.setRead(null);
    await e.advance(10_000);
    check('a present section without a row → a LIVE entry goes out on 0', e.sent.length === 1 && e.sent[0].body.baseVersion === 0 && e.server.row('w1').rating?.score === 4);
  }
  {
    const e = env({ online: false });
    await e.start();
    e.ctl('w1').setScore(4);
    e.ctl('w2').setScore(2);
    await e.advance(1000);
    e.server.webSave('w1', { score: 5 }); // w1 was rated elsewhere; w2 never
    const n = await relaunch(e);
    await n.advance(10);
    check('relaunch, unknown bases: the waited entry WITH a row is dropped, the one without is sent on 0', n.owner.entry(ME, CODE, 'w1') === null && n.server.row('w1').rating?.score === 5 && n.sent.length === 1 && n.sent[0].body.wineId === 'w2' && n.sent[0].body.baseVersion === 0);
  }

  // ── a Home launch: ratings null first, then a present section ────────────
  {
    const e = env({ online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.ctl('w1').setScore(3);
    await e.advance(1000);
    const n = await relaunch(e);
    // The base was known (0) at creation and is persisted: sent at once.
    await n.advance(10);
    check('a Home launch with no session screen: the persisted entry goes out by itself', n.sent.length === 1 && n.server.row('w1').rating?.score === 3);
  }
  {
    const e = env({ online: false });
    await e.start();
    e.ctl('w1').setScore(3);
    await e.advance(1000);
    const n = await relaunch(e, { before: (x) => x.setRead(() => ({ kind: 'ok', ratings: null })) });
    await n.advance(10);
    check('a Home launch, unknown base, ratings null → nothing sent yet', n.sent.length === 0 && n.reads.length === 1);
    n.setRead(null);
    await n.advance(5000);
    check('… a present section arrives → the entry is sent', n.sent.length === 1 && n.server.row('w1').rating?.score === 3);
  }

  // ── Clear, then re-rate ──────────────────────────────────────────────────
  {
    const e = env();
    e.server.webSave('w1', { score: 4, notes: 'x' });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    await c.clearRating();
    await e.flush();
    check('Clear online: a FULL empty save (no merge) on the version seen, the rating gone', lastBody(e)?.merge === undefined && lastBody(e)?.notes === '' && lastBody(e)?.baseVersion === 1 && e.server.row('w1').rating === null && c.draft().score === 0);
    await e.setOnline(false);
    c.setScore(3);
    await e.advance(1000);
    const n = await relaunch(e);
    await n.advance(10);
    check('offline re-rate after the Clear → relaunch → ONE 409 rating:null → rebased, saved', n.sent.length === 2 && n.sent[0].body.baseVersion === 0 && n.sent[1].body.baseVersion === 2 && n.server.row('w1').rating?.score === 3, { sent: n.sent.map((x) => x.body.baseVersion), row: n.server.row('w1') });
  }
  {
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    await c.clearRating();
    await e.flush();
    c.setScore(2);
    await e.advance(1000);
    check('Clear then re-rate online → saved after one 409', e.sent.length === 3 && e.server.row('w1').rating?.score === 2 && c.savedState() === 'saved');
  }
  {
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    e.mode = 'hang';
    c.setScore(5);
    await e.advance(1000);
    const pClear = c.clearRating();
    check('Clear while that edit is in flight: input blocked, "nothing new" while the first attempt flies', c.clearPending() && c.savedState() === null);
    e.mode = 'auto';
    await e.release();
    await pClear;
    await e.flush();
    check('the edit commits, the Clear goes out on the NEW version, no second confirm', e.sent.length === 2 && e.sent[1].body.baseVersion === 2 && e.server.row('w1').rating === null && !e.owner.takeClearAsk(ME, CODE, 'w1'));
  }
  {
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    e.mode = 'hang';
    c.setScore(5);
    await e.advance(1000);
    void c.clearRating();
    e.server.webSave('w1', { score: 1, notes: 'web' }); // lands before our merge
    e.mode = 'auto';
    await e.release();
    check('a Clear staged behind a merge that meets a FOREIGN 409 → not rebased: the newer rating shown, asked again', e.sent.length === 1 && e.server.row('w1').rating?.score === 1 && c.draft().score === 1 && !c.clearPending() && e.owner.takeClearAsk(ME, CODE, 'w1'));
  }
  {
    const e = env({ online: false });
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    await e.ctl('w1').clearRating();
    const n = await relaunch(e, { online: false });
    const c = n.ctl('w1');
    check('an offline Clear survives a restart: cleared display + blocked input', c.clearPending() && c.draft().score === 0);
    await n.setOnline(true);
    await n.advance(10);
    check('… and is sent once online', n.server.row('w1').rating === null && n.sent.length === 1);
  }
  {
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    c.setNotes('kept');
    await e.setOnline(false);
    await e.advance(1000);
    e.queue({ status: 400 }, 'hang');
    await c.clearRating();
    await e.setOnline(true);
    await e.advance(10);
    check('a definitive Clear rejection (400) → the edits restored, the error shown', !c.clearPending() && c.draft().notes === 'kept' && c.savedState() === 'error');
    await e.release();
    check('… the restored edits go out, and the next good save clears the error', e.server.row('w1').rating?.notes === 'kept' && c.savedState() === 'saved');
  }

  // ── another page of the same wine after a Clear ──────────────────────────
  {
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const a = e.ctl('w1');
    const b = e.ctl('w1'); // a retained page on another tab stack
    b.setNotes('half-typed');
    await a.clearRating();
    await e.flush();
    check('a dirty page after a Clear elsewhere resets before taking input', b.draft().notes === '' && b.draft().score === 0);
    await e.advance(2000);
    check('… and its old edit is never sent', e.sent.length === 1 && e.server.row('w1').rating === null);
  }

  // ── Next with the request hanging; departures; storage ───────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    e.mode = 'hang';
    c.setScore(4);
    const ok = await c.drain();
    check('Next with the request hanging moves on at once (stored on the phone)', ok && e.sent.length === 1 && e.disk.size === 1);
    e.mode = 'auto';
    await e.release();
    check('… the entry is sent later and the disk cleared', e.server.row('w1').rating?.score === 4 && e.disk.size === 0);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    const guard = createTransitionGuard();
    c.setSuspended(() => guard.held);
    let moves = 0;
    const depart = () => {
      if (!guard.acquire()) return;
      void c.drain().then((ok) => (ok ? moves++ : guard.release()));
    };
    c.setScore(3);
    depart();
    depart();
    c.setScore(4);
    await e.flush();
    check('two navigation requests during one waiter → one transition; edits wait while it is held', moves === 1 && c.draft().score === 3);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    e.failWrites(true);
    c.setScore(4);
    const p = c.drain();
    await e.advance(2100);
    check('a controlled close with storage failing → false (the editor stays), the error shown, nothing sent', (await p) === false && c.savedState() === 'error' && e.sent.length === 0);
    e.failWrites(false);
    await e.advance(3000);
    check('… the owner keeps retrying: once the write lands the edit goes out', e.server.row('w1').rating?.score === 4);
  }
  {
    const e = env({ online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await c.drain();
    check('stored before discard', e.disk.size === 1);
    c.discardPending({ confirmed: true }); // Delete Impression's success
    await e.flush();
    await e.setOnline(true);
    await e.advance(10);
    check('discardPending({ confirmed }) → the stored entry is gone at once, nothing sent', e.disk.size === 0 && e.sent.length === 0);
  }

  // ── the line-up overlay ──────────────────────────────────────────────────
  {
    const e = env({ online: false });
    e.server.webSave('w1', { score: 2 });
    e.poll();
    await e.start();
    const c = e.ctl('w2');
    c.setScore(4);
    await c.drain();
    const raw = e.cache.get(CODE)!.ratings;
    const over = e.owner.overlay(ME, CODE, raw);
    check('an offline Finish: the line-up rows show the stored ratings, Compare (raw) does not', over?.[ID].ratings.w2?.score === 4 && over?.[ID].ratings.w1?.score === 2 && raw?.[ID].ratings.w2 === undefined);
  }
  {
    const e = env({ online: false });
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(0);
    await c.drain();
    check('a score-only 4 dragged to 0 + offline Finish → the line-up keeps the 4', e.owner.overlay(ME, CODE, e.cache.get(CODE)!.ratings)?.[ID].ratings.w1?.score === 4);
    await e.setOnline(true);
    await e.advance(10);
    check('… also after `unchanged` (nothing written, the stored rating kept)', e.sent.length === 1 && e.server.row('w1').rating?.score === 4 && e.owner.overlay(ME, CODE, e.cache.get(CODE)!.ratings)?.[ID].ratings.w1?.score === 4);
    await e.advance(60_000);
    check('`unchanged` → parked, no loop', e.sent.length === 1);
    c.setNotes('now with a note');
    await e.advance(1000);
    check('a newer edit un-parks: the score goes out with it', e.sent.length === 2 && e.sent[1].body.score === 0 && e.sent[1].body.notes === 'now with a note');
  }

  // ── set 4, Next, the answer lands with ratings: null, Previous ───────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const a = e.ctl('w1');
    a.setScore(4);
    await a.drain();
    a.dispose();
    e.poll(null); // the next /state answered `ratings: null`
    const back = e.ctl('w1');
    check('set 4, Next, ratings: null, Previous → shows 4 (the remembered answer)', back.draft().score === 4 && back.baselineReady());
  }

  // ── save 4 while ratings: null, reopen, edit to 4.5, restart ─────────────
  {
    const e = env();
    await e.start();
    e.setRead(() => ({ kind: 'ok', ratings: e.server.section() }));
    const a = e.ctl('w1');
    a.setScore(4);
    await e.advance(1000);
    await e.advance(10);
    check('saved on 0 once a section came', e.server.row('w1').version === 1);
    e.cache.set(CODE, { ratings: null }); // the screen's poll keeps answering null
    const b = e.ctl('w1');
    await e.setOnline(false);
    b.setScore(4.5);
    await b.drain();
    const n = await relaunch(e);
    await n.advance(10);
    check('edit to 4.5, restart → sent on the ACKNOWLEDGED version (1), no drop', n.sent.length === 1 && n.sent[0].body.baseVersion === 1 && n.server.row('w1').rating?.score === 4.5);
  }

  // ── a pre-release rating, an offline note, a web Reset ───────────────────
  {
    const e = env({ online: false });
    e.server.legacy('w1', { score: 3 });
    e.poll();
    await e.start();
    e.ctl('w1').setNotes('later');
    await e.advance(1000);
    check('a pre-release rating: base 0 WITH a rating', JSON.parse(e.disk.get(storageKey(ME, CODE, 'w1'))!).baseHadRating === true);
    e.server.webReset('w1');
    const n = await relaunch(e);
    await n.advance(10);
    check('… a web Reset meanwhile → the note is dropped (never brings the cleared rating back)', n.server.row('w1').rating === null && n.owner.entry(ME, CODE, 'w1') === null);
  }

  // ── 3 → 4 → 3 inside the timer ───────────────────────────────────────────
  {
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(500);
    c.setScore(3);
    await e.advance(1000);
    check('3 → 4 → 3 inside the timer → no score sent', e.sent.length === 0 && e.owner.entry(ME, CODE, 'w1') === null);
  }

  // ── a kill mid-send ──────────────────────────────────────────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = 'hang';
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    const first = e.sent[0].body.opId;
    const n = await relaunch(e); // the app was killed with the request out
    await n.advance(10);
    check('a kill mid-send → the same op id re-sent', n.sent.length === 1 && n.sent[0].body.opId === first && n.server.row('w1').rating?.score === 4);
  }

  // ── auth: 401 invalid, sign-out, a revoked session ───────────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.setSession('none');
    e.queue({ status: 401, auth: 'invalid' });
    e.ctl('w1').setScore(4);
    e.ctl('w2').setScore(3);
    e.ctl('w3').setScore(2);
    await e.advance(1000);
    await e.advance(60_000);
    check('a revoked session: 401 invalid → get-session says signed out → all three kept, the runner stopped', e.disk.size === 3 && e.sent.length <= 3 && e.owner._debug().stopped, { sent: e.sent.length, disk: e.disk.size });
    const before = e.sent.length;
    e.signOut();
    e.setSession('same');
    await e.signIn();
    await e.advance(10);
    check('… sent after the next sign-in', e.server.row('w1').rating?.score === 4 && e.server.row('w2').rating?.score === 3 && e.server.row('w3').rating?.score === 2 && e.sent.length > before && e.disk.size === 0);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.setSession('same');
    e.queue({ status: 401, auth: 'invalid' });
    e.ctl('w1').setScore(4);
    e.ctl('w2').setScore(3);
    await e.advance(1000);
    await e.advance(10);
    check('401 invalid, still this viewer → that entry dropped (no longer a member), the others go on', e.owner.entry(ME, CODE, 'w1') === null || e.owner.entry(ME, CODE, 'w2') === null);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = 'hang';
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.signOut(); // the viewer epoch + auth generation move
    await e.release();
    const stored = JSON.parse(e.disk.get(storageKey(ME, CODE, 'w1'))!);
    check('sign-out after dispatch → the late answer has no effect on the stored entry', !!stored.unresolvedOp && e.disk.size === 1);
  }

  // ── 404 / 429 / 503 / update_required ────────────────────────────────────
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.queue({ status: 404 });
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    check('404 → dropped, silent', e.owner.entry(ME, CODE, 'w1') === null && e.disk.size === 0 && e.alerts.length === 0);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.queue({ status: 429, retryAfterMs: 30_000 });
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.ctl('w2').setScore(3);
    await e.advance(1000);
    check('429 → EVERY entry of the viewer waits (one request so far)', e.sent.length === 1);
    await e.advance(29_000);
    check('… after Retry-After both go out (a 429 fatal view never drops an entry)', e.server.row('w1').rating?.score === 4 && e.server.row('w2').rating?.score === 3);
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = { status: 503, retryAfterMs: 5000 };
    for (let i = 1; i <= 6; i++) e.ctl(`w${i}`).setScore(4);
    await e.advance(1000);
    await e.advance(10 * 60_000);
    check('six entries answering 503 for 10 min → under 20 requests', e.sent.length < 20, e.sent.length);
    e.mode = 'auto';
    await e.advance(6 * 60_000);
    check('… and all six land once the moment answers', [1, 2, 3, 4, 5, 6].every((i) => e.server.row(`w${i}`).rating?.score === 4));
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue({ status: 400 });
    c.setScore(4);
    await e.advance(1000);
    check('400 → dropped with the footer error (a client bug, logged)', e.owner.entry(ME, CODE, 'w1') === null && c.savedState() === 'error');
  }
  {
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = 'update';
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    await e.advance(30 * 60_000);
    check('update_required → the runner stops until the next launch (one request, no backoff loop)', e.sent.length === 1 && e.owner._debug().updateStopped && e.disk.size === 1);
  }


  // ── review fixes (Fable r1) ──────────────────────────────────────────────
  {
    // 1. An error stays until the next GOOD save, not until the next keystroke.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue({ status: 400 });
    c.setScore(4);
    await e.advance(1000);
    c.setNotes('typing again');
    check('r1-1: the footer error survives a keystroke', c.savedState() === 'error');
    await e.advance(1000);
    check('r1-1: … and clears with the next GOOD save', c.savedState() === 'saved' && c.error() === null);
  }
  {
    // 4 + 11. A 400 shows the shared copy, never the server's developer
    // string; the log carries the op id, field names and message, no values.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue({ status: 400, message: 'aroma modifier must be a string or null' });
    c.setNotes('a private thought');
    await e.advance(1000);
    const logged = JSON.stringify(e.logs);
    check('r1-4: a 400 shows the shared error copy, not the server message', c.error() === SAVE_ERROR_TEXT);
    check('r1-11: the 400 log has the op id, the field names and the message, never the note', logged.includes('aroma modifier') && logged.includes('"fields":["notes"]') && logged.includes('"opId"') && !logged.includes('a private thought'), e.logs);
  }
  {
    // 2. An answer dropped because the auth generation moved (a cookie
    // refresh) keeps the entry moving: the SAME op goes out again soon.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = 'hang';
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.bumpGen();
    e.mode = 'auto';
    await e.release();
    const first = e.sent[0].body.opId;
    await e.advance(1500);
    check('r1-2: a stale-stamp answer is discarded and the SAME op re-sent shortly', e.sent.length === 2 && e.sent[1].body.opId === first && e.server.row('w1').rating?.score === 4 && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // 2. A discarded 503 PROBE frees its moment: the siblings go on.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.mode = { status: 503, retryAfterMs: 5000 };
    e.ctl('w1').setScore(4);
    e.ctl('w2').setScore(3);
    await e.advance(1000);
    e.mode = 'hang';
    await e.advance(5000); // one probe goes out and hangs
    const probes = e.sent.length;
    e.bumpGen();
    e.mode = 'auto';
    await e.release();
    await e.advance(2000);
    check('r1-2: a discarded 503 probe does not strand the moment', e.sent.length > probes && e.server.row('w1').rating?.score === 4 && e.server.row('w2').rating?.score === 3, { probes, sent: e.sent.length });
  }
  {
    // 3. The line-up overlay keeps ONE object while nothing it shows changed.
    const e = env({ online: false });
    e.server.webSave('w1', { score: 2 });
    e.poll();
    await e.start();
    const c = e.ctl('w2');
    c.setScore(4);
    await c.drain();
    const raw = e.cache.get(CODE)!.ratings;
    const a = e.owner.overlay(ME, CODE, raw);
    e.owner.touch(); // an unrelated owner change
    const b = e.owner.overlay(ME, CODE, raw);
    c.setScore(4.5);
    await c.drain();
    const d = e.owner.overlay(ME, CODE, raw);
    check('r1-3: same ratings + value-equal own rows → the same object; a real change → a new one', a === b && d !== b && d?.[ID].ratings.w2?.score === 4.5);
  }
  {
    // 5. Hydration's read failed: a stage reads (and merges) that key before
    // its first write, so the stored unsent edit is never replaced unread.
    const disk = new Map<string, string>();
    const t0 = 5_000_000_000;
    const stored = { viewer: ME, code: CODE, wineId: 'w1', fields: { notes: { value: 'from yesterday', rev: 1 } }, ackRev: {}, parked: {}, nextRev: 1, baseVersion: 3, baseHadRating: true, waited: true, rebased: false, acked: false, nextAt: 0, attempts: 0, createdAt: t0 - 1000, updatedAt: t0 - 1000, editedAt: t0 - 1000 };
    disk.set(storageKey(ME, CODE, 'w1'), JSON.stringify(stored));
    const e = env({ disk, t0, online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    e.failReads(true, 2); // getAllKeys fails twice (hydration gives up), then the first per-key read too
    await e.start();
    await e.advance(1500);
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(1000);
    const mid = JSON.parse(disk.get(storageKey(ME, CODE, 'w1'))!);
    check('r1-5: the key read failing too → nothing written over the stored entry', mid.fields.notes?.value === 'from yesterday' && mid.fields.score === undefined);
    await e.advance(3000);
    const merged = JSON.parse(disk.get(storageKey(ME, CODE, 'w1'))!);
    check('r1-5: once the key reads, the page edit is MERGED onto the stored entry (its base kept)', merged.fields.notes?.value === 'from yesterday' && merged.fields.score?.value === 4 && merged.baseVersion === 3, merged.fields);
  }
  {
    // 6. The 90 days count from the last EDIT, not from a backoff or a
    // hydration write; an entry without `editedAt` counts from `updatedAt`.
    const disk = new Map<string, string>();
    const t0 = 20_000_000_000;
    const base = { viewer: ME, code: CODE, fields: { score: { value: 4, rev: 1 } }, ackRev: {}, parked: {}, nextRev: 1, baseVersion: 0, baseHadRating: false, waited: true, rebased: false, acked: false, nextAt: 0, attempts: 3, createdAt: 0 };
    const stuck = { ...base, wineId: 'w1', updatedAt: t0 - 1000, editedAt: t0 - CLEANUP_MS - 1 };
    const legacy = { ...base, wineId: 'w2', updatedAt: t0 - CLEANUP_MS - 1 };
    const recent = { ...base, wineId: 'w3', updatedAt: t0 - 1000, editedAt: t0 - 1000 };
    for (const x of [stuck, legacy, recent]) disk.set(storageKey(ME, CODE, x.wineId), JSON.stringify(x));
    const e = env({ disk, t0, online: false });
    await e.start();
    check('r1-6: the viewer\'s own stuck entry (backoff writes, last edit > 90 days) is removed', !disk.has(storageKey(ME, CODE, 'w1')) && !disk.has(storageKey(ME, CODE, 'w2')) && disk.has(storageKey(ME, CODE, 'w3')));
    e.ctl('w3').setScore(5);
    await e.advance(1000);
    const w3 = JSON.parse(disk.get(storageKey(ME, CODE, 'w3'))!);
    check('r1-6: an edit stamps `editedAt`', w3.editedAt >= t0);
  }
  {
    // 10. An unanswered get-session after a 401 is asked again with the
    // backoff while the same viewer is signed in.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.sessions('unknown', 'unknown', 'same');
    e.queue({ status: 401, auth: 'invalid' });
    e.ctl('w1').setScore(4);
    e.ctl('w2').setScore(3);
    await e.advance(1000);
    check('r1-10: no answer → still stopped, entries kept', e.owner._debug().stopped && e.disk.size >= 1);
    await e.advance(20_000);
    check('r1-10: … asked again with the backoff; "same" → that entry dropped, the runner resumes', !e.owner._debug().stopped && e.server.row('w2').rating?.score === 3 && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // 10. A sign-out ends the retries (nothing asked for the old viewer).
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.sessions('unknown');
    e.setSession('unknown');
    e.queue({ status: 401, auth: 'invalid' });
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.signOut();
    e.setSession('same');
    await e.advance(10 * 60_000);
    check('r1-10: after a sign-out the retries stop, the entry stays stored', e.disk.size === 1 && e.owner.viewer() === null);
  }


  // ── Codex xhigh + Fable recheck ──────────────────────────────────────────
  {
    // Codex P1 (b)(i): every merge and Clear body carries the entry's viewer.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(1000);
    await c.clearRating();
    await e.flush();
    check('cx-viewer: the merge and the Clear carry viewer u:<publicId>', e.sent.length === 2 && e.sent.every((x) => x.body.viewer === ID), e.sent.map((x) => x.body.viewer));
  }
  {
    // Codex P1 (b)(i): 409 wrongViewer → stop, keep, get-session; another
    // account's session → held; the right account signed in → sent, never dropped.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.cookieAs('u:someoneElse0');
    e.setSession('other');
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    await e.advance(60_000);
    check('cx-wrong-viewer: refused → runner stopped, the entry kept, nothing written', e.sent.length === 1 && e.owner._debug().stopped && e.disk.size === 1 && e.server.row('w1').rating === null);
    e.signOut();
    e.cookieAs(ID);
    e.setSession('same');
    await e.signIn();
    await e.advance(10);
    check('cx-wrong-viewer: … sent once the right account is signed in', e.server.row('w1').rating?.score === 4 && e.disk.size === 0);
  }
  {
    // Codex P1 (b)(i): wrongViewer then get-session "same" → not dropped, it backs off and goes again.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.cookieAs('u:someoneElse0');
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.cookieAs(ID);
    await e.advance(10_000);
    check('cx-wrong-viewer: "same" → resumed, the entry kept and saved', e.server.row('w1').rating?.score === 4 && !e.owner._debug().stopped);
  }
  {
    // Codex P1 (b)(ii): a launch under ANOTHER account's credential holds the
    // queue: no send, no /state read trusted as a base.
    const e = env({ online: false });
    await e.start();
    e.ctl('w1').setScore(4); // no snapshot: an unknown base
    await e.advance(1000);
    const n = await relaunch(e, { before: (x) => { x.setSession('other'); } });
    n.poll({ [ID]: { displayName: 'Me', ratings: {} } }); // the line-up's poll under that credential
    await n.advance(60_000);
    const stored = JSON.parse(n.disk.get(storageKey(ME, CODE, 'w1'))!);
    check('cx-owner: another account\'s session at launch → nothing sent, no read, the base stays unknown', n.sent.length === 0 && n.reads.length === 0 && stored.baseVersion === 'unknown' && n.confirms >= 1);
    n.setSession('same');
    n.bumpGen(); // the right account signs in: the generation moves
    const asked = n.confirms;
    n.owner.touch(); // any query activity
    await n.flush();
    check('cx-owner: … the next query activity re-asks get-session for the new generation', n.confirms === asked + 1);
    n.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await n.advance(10_000);
    check('cx-owner: … confirmed for the new generation → read, sent on 0', n.sent.length === 1 && n.sent[0].body.baseVersion === 0 && n.server.row('w1').rating?.score === 4);
  }
  {
    // Codex P1 (b)(ii): an auth-generation change → get-session again before the next send.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    const before = e.confirms;
    e.bumpGen();
    e.ctl('w2').setScore(3);
    await e.advance(1000);
    check('cx-owner: a generation change re-confirms the owner before sending', e.confirms === before + 1 && e.server.row('w2').rating?.score === 3);
  }
  {
    // Codex P1 (a): the base is latched at the first edit, not at the stage.
    // Edit offline on v1, reconnect, a poll brings v2, then the stage.
    const e = env({ online: false });
    e.server.webSave('w1', { score: 3, notes: 'old' });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setNotes('mine'); // the timer is still running
    await e.setOnline(true);
    e.server.webSave('w1', { score: 3, notes: 'newer from the web' });
    e.poll();
    await e.advance(1000);
    await e.advance(10);
    check('cx-latch: the merge goes out on v1 (what the page showed), never v2', e.sent.length === 1 && e.sent[0].body.baseVersion === 1, e.sent.map((x) => x.body.baseVersion));
    check('cx-latch: … offline provenance → waited → dropped by the 409; the newer note stays', e.server.row('w1').rating?.notes === 'newer from the web' && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // Codex P1 (b): the snapshot moves while the confirm is open → the Clear
    // goes out on the DISPLAYED version → 409 → the stale-Clear path.
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    const token = c.clearBaseline(); // the alert opens
    e.server.webSave('w1', { score: 2, notes: 'web' });
    e.poll(); // a poll while the alert is up
    await c.clearRating(token);
    await e.flush();
    check('cx-clear: the Clear goes out on the displayed version, meets a 409, the newer rating stays, asked again', e.sent.length === 1 && e.sent[0].body.baseVersion === 1 && e.server.row('w1').rating?.score === 2 && e.owner.takeClearAsk(ME, CODE, 'w1') && c.draft().score === 2);
  }
  {
    // Codex P1 (b): a 400 restores the UNSETTLED note (taken atomically into the restore).
    const e = env();
    e.server.webSave('w1', { score: 4 });
    e.poll();
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    c.setNotes('unsettled');
    e.queue({ status: 400 }, 'hang');
    await c.clearRating();
    await e.flush();
    check('cx-clear: the unsettled note was never sent as a merge of its own', e.sent.length >= 1 && e.sent[0].body.merge === undefined);
    check('cx-clear: a 400 restores the unsettled note, the error shown', c.draft().notes === 'unsettled' && c.savedState() === 'error');
    await e.release();
  }
  {
    // Codex P2 (a): the gate closes during the write-ahead wait → nothing sent,
    // the persisted op kept, the same op once the gate opens.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.holdWrites(true);
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    await e.setOnline(false);
    await e.releaseWrites();
    check('cx-gate: offline by the time the write lands → nothing sent, not even handed to the transport', e.sendCalls === 0 && e.sent.length === 0 && JSON.parse(e.disk.get(storageKey(ME, CODE, 'w1'))!).unresolvedOp);
    const op = JSON.parse(e.disk.get(storageKey(ME, CODE, 'w1'))!).unresolvedOp.opId;
    await e.setOnline(true);
    await e.advance(10);
    check('cx-gate: … back online → that persisted op goes out', e.sent.length === 1 && e.sent[0].body.opId === op && e.server.row('w1').rating?.score === 4);
  }
  {
    // Fable P3 1: a Clear doesn't erase the footer error; only a good save does.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue({ status: 400 });
    c.setScore(4);
    await e.advance(1000);
    e.queue('hang');
    void c.clearRating();
    await e.flush();
    check('fx-1: the error stays while the Clear is pending', c.savedState() === 'error');
    await e.release();
  }
  {
    // Fable P3 2: the get-session retry ends with the viewer; online again → asked at once.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.setSession('unknown');
    e.queue({ status: 401, auth: 'invalid' });
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    const a = e.confirms;
    await e.setOnline(false);
    await e.setOnline(true);
    check('fx-2: back online → the pending get-session is asked again at once', e.confirms === a + 1);
    e.signOut();
    const b = e.confirms;
    await e.advance(30 * 60_000);
    check('fx-2: after a sign-out the retry timer asks nothing more', e.confirms === b);
  }
  {
    // Fable P3 4 + 5: after a failed launch read, a discard isn't undone by the
    // key read, and a page Clear merged over a stored entry keeps its own restore.
    const t0 = 5_000_000_000;
    const stored = (wineId: string) => ({ viewer: ME, code: CODE, wineId, fields: { notes: { value: 'from yesterday', rev: 1 } }, ackRev: {}, parked: {}, nextRev: 1, baseVersion: 3, baseHadRating: true, waited: true, rebased: false, acked: false, nextAt: 0, attempts: 0, createdAt: t0 - 1000, updatedAt: t0 - 1000, editedAt: t0 - 1000 });
    const disk = new Map<string, string>();
    disk.set(storageKey(ME, CODE, 'w1'), JSON.stringify(stored('w1')));
    disk.set(storageKey(ME, CODE, 'w2'), JSON.stringify(stored('w2')));
    const e = env({ disk, t0, online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    e.failReads(true, 0); // the launch read fails, the per-key reads work
    await e.start();
    await e.advance(1500);
    const d = e.ctl('w1');
    d.discardPending({ confirmed: true });
    await e.advance(10);
    check('fx-4: a discard after a failed launch read is written, not undone by the key read', !disk.has(storageKey(ME, CODE, 'w1')));
    const c = e.ctl('w2');
    c.setScore(4); // unsettled
    await c.clearRating();
    await e.advance(10);
    const w2 = JSON.parse(disk.get(storageKey(ME, CODE, 'w2'))!);
    check('fx-5: the page Clear over the stored entry keeps its own restore with the stored edits', w2.clear && w2.clear.restore.notes === 'from yesterday' && w2.clear.restore.score === 4, w2.clear);
  }


  {
    // Codex P2 (a), the second place: the gate closes during the binding's
    // cookie read → beforeSend cancels ('ineligible'), the op stays, then goes.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.holdCookie(true);
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    await e.flush();
    const handed = e.sendCalls;
    await e.setOnline(false);
    await e.releaseCookie();
    const raw = e.disk.get(storageKey(ME, CODE, 'w1'));
    const stored = raw ? JSON.parse(raw) : null;
    check('cx-gate: offline during the cookie read → cancelled locally, the op kept', handed === 1 && e.sent.length === 0 && !!stored?.unresolvedOp && !e.owner._debug().stopped);
    await e.setOnline(true);
    await e.advance(10);
    check('cx-gate: … back online → that same op goes out', e.sent.length === 1 && e.sent[0].body.opId === stored?.unresolvedOp?.opId && e.server.row('w1').rating?.score === 4);
  }
  {
    // Codex P1 (b)(ii), the read side: a /state read in flight when the auth
    // generation moves to ANOTHER account's credential is not taken as a base.
    const e = env({ online: false });
    await e.start();
    e.ctl('w1').setScore(4); // no snapshot: an unknown base
    await e.advance(1000);
    e.holdReads(true);
    await e.setOnline(true); // owner confirmed, the read leaves
    await e.flush();
    const left = e.reads.length;
    e.bumpGen();
    e.setSession('other');
    e.setRead(() => ({ kind: 'removed' })); // that account was removed from the moment
    await e.releaseReads();
    await e.advance(60_000);
    const raw = e.disk.get(storageKey(ME, CODE, 'w1'));
    const stored = raw ? JSON.parse(raw) : null;
    check('cx-owner: a read answered under another account\'s credential drops nothing and is no base; nothing sent', left === 1 && stored?.baseVersion === 'unknown' && e.sent.length === 0);
    e.setRead(null);
  }
  {
    // Codex P1 (a), the seed: a net-zero edit (4 and back to 3 inside the
    // settle) while a poll brings a newer web rating is NOT staged: it would
    // overwrite the web's 5 with 3 through the live rebase.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    c.setScore(3);
    e.server.webSave('w1', { score: 5 });
    e.poll();
    await e.advance(1000);
    await e.advance(10_000);
    check('cx-latch: a net-zero edit against what the page showed sends nothing; the web\'s 5 stays', e.sent.length === 0 && e.server.row('w1').rating?.score === 5 && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // r1-1 / Fable P3 1, staged: the error also survives the next STAGE while its save is out.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue({ status: 400 }, 'hang');
    c.setScore(4);
    await e.advance(1000);
    c.setNotes('again');
    await e.advance(1000);
    check('r1-1: the footer error survives the next staged save while it is on the wire', e.sent.length === 2 && c.savedState() === 'error');
    await e.release();
  }


  // ── Codex recheck 1 + Fable P3s ──────────────────────────────────────────
  {
    // r2-1a: a Clear confirm opened before the rating loaded deletes nothing.
    const e = env();
    e.server.webSave('w1', { score: 4 });
    await e.start(); // no section yet
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    const ready0 = c.baselineReady();
    const token = c.clearBaseline(); // the alert would be open here
    e.poll(); // v1 found afterwards
    const ok = await c.clearRating(token);
    await e.flush();
    check('r2-1a: unknown baseline → Clear unavailable; a token taken then deletes nothing', !ready0 && ok === false && e.sent.length === 0 && e.server.row('w1').rating?.score === 4);
  }
  {
    // r2-1b: the entry rebased onto a web save while the confirm was open →
    // Delete deletes nothing and asks again on the newer rating.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue('hang');
    c.setScore(4);
    await e.advance(1000); // the merge is out on v1
    const token = c.clearBaseline();
    e.server.webSave('w1', { score: 3, notes: 'from the web' }); // v2
    await e.release(); // 409 → the live rebase onto v2
    const ok = await c.clearRating(token);
    await e.advance(10);
    check('r2-1b: rebased since the token → no Clear, asked again, the web\'s note kept', ok === false && !e.sent.some((x) => x.body.merge === undefined) && e.server.row('w1').rating?.notes === 'from the web' && e.owner.takeClearAsk(ME, CODE, 'w1'));
  }
  {
    // r2-2: a note started online, continued OFFLINE, reconnected before the
    // settle; a web save meanwhile → the waited merge is dropped, never rebased.
    const e = env();
    e.server.webSave('w1', { score: 3, notes: 'old' });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setNotes('a');
    await e.setOnline(false);
    c.setNotes('ab');
    e.server.webSave('w1', { score: 3, notes: 'newer' });
    await e.setOnline(true);
    await e.advance(1000);
    await e.advance(10_000);
    check('r2-2: an offline edit anywhere in the draft → the newer web note stays', e.server.row('w1').rating?.notes === 'newer' && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // r2-2 + r2-7: an earlier entry finishes during the debounce of an offline
    // edit; reconnected before the settle → the new entry is waited and based
    // on the OWN acknowledged save (never the older latch).
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.queue('hang');
    c.setScore(4);
    await e.advance(1000); // out on v1
    await e.setOnline(false);
    c.setNotes('offline'); // latched while the entry still exists
    await e.release(); // acknowledged: v2, the entry done
    await e.setOnline(true);
    e.server.webSave('w1', { score: 4, notes: 'web' }); // v3
    await e.advance(1000);
    await e.advance(10_000);
    const merge = e.sent.find((x) => x.body.notes === 'offline');
    check('r2-2/7: the later merge goes out on the own ack (v2), waited → dropped by v3', merge?.body.baseVersion === 2 && e.server.row('w1').rating?.notes === 'web');
  }
  {
    // r2-3: a /state read sent before an auth change answers `removed` after
    // the new generation is confirmed → dropped whole; read again, then sent.
    const e = env({ online: false });
    await e.start();
    e.ctl('w1').setScore(4); // no snapshot: an unknown base
    await e.advance(1000);
    e.holdReads(true);
    let first = true;
    e.setRead(() => (first ? ((first = false), { kind: 'removed' as const }) : { kind: 'ok' as const, ratings: e.server.section() }));
    await e.setOnline(true);
    await e.flush();
    e.bumpGen(); // a cookie refresh, same account
    e.owner.touch(); // confirmed again for the new generation
    await e.flush();
    await e.releaseReads();
    await e.advance(10);
    check('r2-3: an old read\'s `removed` drops nothing; the entry is read again and saved', e.reads.length === 2 && e.server.row('w1').rating?.score === 4);
    e.setRead(null);
  }
  {
    // r2-3: a cached section fetched under an older generation is no snapshot and no base.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    await e.start();
    const old = e.genNow();
    e.bumpGen();
    e.owner.touch();
    await e.flush();
    e.poll(e.server.section(), old);
    const c = e.ctl('w1');
    const stale = c.baselineReady();
    e.poll();
    check('r2-3: a section of an older generation → no baseline; one of the current → ready', !stale && c.baselineReady());
  }
  {
    // r2-3: an older generation's section gives a base-less entry no base.
    const e = env({ online: false });
    await e.start();
    const old = e.genNow();
    e.bumpGen();
    e.owner.touch();
    await e.flush();
    e.ctl('w1').setScore(4);
    await e.advance(1000);
    e.server.webSave('w1', { score: 2 });
    e.poll(e.server.section(), old);
    await e.advance(10);
    const raw = e.disk.get(storageKey(ME, CODE, 'w1'));
    check('r2-3: … and no base for an entry without one', !!raw && JSON.parse(raw).baseVersion === 'unknown');
  }
  {
    // r2-4: the note started at score 3, a poll brings 4, the score set back
    // to 3 → the score IS sent (its seed is the 4 the person saw).
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setNotes('n');
    e.server.webSave('w1', { score: 4 });
    e.poll();
    c.setScore(3);
    await e.advance(1000);
    await e.advance(10_000);
    check('r2-4: a field first touched after a poll compares with what was then shown', e.sent.some((x) => x.body.score === 3) && e.server.row('w1').rating?.score === 3);
  }
  {
    // r2-5: A probes a 503'd moment; B's OLDER request fails → the probe stays
    // A's, C waits for it.
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    e.queue('hang', { status: 503 }, 'hang');
    e.ctl('w2').setScore(2); // B
    await e.advance(1000);
    e.ctl('w1').setScore(1); // A → 503
    await e.advance(1000);
    e.ctl('w3').setScore(3); // C waits for the pause
    await e.advance(1000);
    await e.advance(5000); // the pause ends: A probes (hang)
    const before = e.sent.length;
    await e.releaseOne({ kind: 'network', error: new Error('lost') }); // B's older request
    await e.flush();
    check('r2-5: another request\'s answer never frees the probe', before === 3 && e.sent.length === 3 && !e.sent.some((x) => x.body.wineId === 'w3'));
    await e.release();
  }
  {
    // r2-6: get-session answers that keep coming back under a moved
    // generation are asked again at once ONCE, then with the backoff.
    const e = env();
    e.bumpOnConfirm(3);
    await e.start();
    const a = e.confirms;
    await e.advance(backoffMs(1) - 1);
    const b = e.confirms;
    await e.advance(1);
    check('r2-6: the second moved answer backs off', a === 2 && b === 2 && e.confirms === 3, { a, b, c: e.confirms });
  }
  {
    // r2-7: the token was taken before the OWN merge was acknowledged → the
    // Clear goes out on that ack, no second confirm.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    e.owner.setVisible(ME, CODE, 'w1', 1, true);
    const c = e.ctl('w1');
    e.queue('hang');
    c.setScore(4);
    await e.advance(1000);
    const token = c.clearBaseline(); // base v1 on screen
    await e.release(); // own ack → v2, the entry done
    await c.clearRating(token);
    await e.advance(10);
    const clr = e.sent.find((x) => x.body.merge === undefined);
    check('r2-7: the Clear goes out on the own ack (v2) and deletes, no re-ask', clr?.body.baseVersion === 2 && e.server.row('w1').rating === null && !e.owner.takeClearAsk(ME, CODE, 'w1'));
  }


  // ── Codex recheck 2 ──────────────────────────────────────────────────────
  {
    // r3-1: saved on the phone, Reset on the web, the phone sees it empty,
    // rated offline, reconnected → saved on `0, false` (never the old ack).
    const e = env();
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(1000); // own ack v1
    e.server.webReset('w1'); // v2, no rating
    e.poll();
    await e.setOnline(false);
    c.setScore(3);
    await e.advance(1000);
    await e.setOnline(true);
    await e.advance(10);
    const merge = e.sent.find((x) => x.body.score === 3);
    check('r3-1: a re-rate after an observed web Reset goes out on 0 and is saved', merge?.body.baseVersion === 0 && e.server.row('w1').rating?.score === 3);
  }
  {
    // r3-2: a save 3 → 4 held, the shown 4 set back to 3, the first save
    // acknowledged during the debounce → the 3 IS sent and stays shown.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    e.queue('hang');
    c.setScore(4);
    await e.advance(1000);
    c.setScore(3);
    await e.release(); // v2 = 4
    await e.advance(1000);
    await e.advance(10);
    const back = e.sent.find((x) => x.body.score === 3);
    check('r3-2: the reversal is compared with the acknowledged 4 and saved on v2', back?.body.baseVersion === 2 && e.server.row('w1').rating?.score === 3 && c.draft().score === 3);
  }
  {
    // r3-2: a predecessor that never went out keeps the cancellation.
    const e = env({ online: false });
    e.server.webSave('w1', { score: 3 });
    e.poll();
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await e.advance(1000); // staged, not sent (offline)
    c.setScore(3);
    await e.advance(1000);
    await e.setOnline(true);
    await e.advance(10);
    check('r3-2: back to the server\'s value before it went out → nothing sent', e.sent.length === 0 && e.owner.entry(ME, CODE, 'w1') === null);
  }
  {
    // r3-3: discardPending() is a REQUEST: a current, confirmed read that
    // still lists the bottle keeps the entry, and it goes out.
    const e = env({ online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await c.drain();
    c.discardPending();
    await e.flush();
    const kept = e.disk.size === 1;
    e.setRead(() => ({ kind: 'ok', ratings: e.server.section(), wineIds: ['w1', 'w2'] }));
    await e.setOnline(true);
    await e.advance(10);
    check('r3-3: unverified (offline) and contrary (still listed) → the entry kept and saved', kept && e.reads.length === 1 && e.server.row('w1').rating?.score === 4);
    e.setRead(null);
  }
  {
    // r3-3: a confirmed read of a present line-up WITHOUT the bottle deletes.
    const e = env({ online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await c.drain();
    c.discardPending();
    e.holdCookie(true); // the entry's own send waits at the cookie read
    e.setRead(() => ({ kind: 'ok', ratings: e.server.section(), wineIds: ['w2'] }));
    await e.setOnline(true);
    await e.flush();
    await e.releaseCookie();
    await e.advance(10);
    check('r3-3: confirmed gone → deleted, nothing sent', e.disk.size === 0 && e.sent.length === 0 && e.owner.entry(ME, CODE, 'w1') === null);
    e.setRead(null);
  }
  {
    // r3-3: a `removed` answered by a read sent before an auth change deletes
    // nothing; the fresh read (still listed) keeps the entry.
    const e = env({ online: false });
    e.poll({ [ID]: { displayName: 'Me', ratings: {} } });
    await e.start();
    const c = e.ctl('w1');
    c.setScore(4);
    await c.drain();
    c.discardPending();
    e.holdCookie(true);
    e.holdReads(true);
    let first = true;
    e.setRead(() => (first ? ((first = false), { kind: 'removed' as const }) : { kind: 'ok' as const, ratings: e.server.section(), wineIds: ['w1'] }));
    await e.setOnline(true);
    await e.flush();
    e.bumpGen();
    e.owner.touch();
    await e.flush();
    await e.releaseReads();
    await e.advance(10);
    check('r3-3: an old read\'s `removed` deletes nothing', e.disk.size === 1 && e.reads.length === 2);
    await e.releaseCookie();
    e.setRead(null);
  }
  {
    // r3-4: with the screen cache empty, the outbox's own confirmed read is
    // the snapshot too: the editor shows the stored 3 and is baseline-ready.
    const e = env();
    e.server.webSave('w1', { score: 3 });
    await e.start(); // no screen poll
    const c = e.ctl('w1');
    e.queue('hang');
    c.setNotes('n');
    await e.advance(1000); // base unknown → the outbox reads, then sends on v1
    check('r3-4: the read\'s section reaches the snapshot', e.sent.length === 1 && e.sent[0].body.baseVersion === 1 && c.baselineReady() && c.draft().score === 3);
    await e.release();
  }

  // ── the 90-day clean-up ──────────────────────────────────────────────────
  {
    const disk = new Map<string, string>();
    const t0 = 10_000_000_000;
    const old = { viewer: 'other0000001', code: CODE, wineId: 'w9', fields: { score: { value: 4, rev: 1 } }, ackRev: {}, parked: {}, nextRev: 1, baseVersion: 0, baseHadRating: false, waited: true, rebased: false, acked: false, nextAt: 0, attempts: 0, createdAt: t0 - CLEANUP_MS - 1, updatedAt: t0 - CLEANUP_MS - 1 };
    const fresh = { ...old, wineId: 'w8', createdAt: t0 - 1000, updatedAt: t0 - 1000 };
    disk.set(storageKey(old.viewer, CODE, 'w9'), JSON.stringify(old));
    disk.set(storageKey(old.viewer, CODE, 'w8'), JSON.stringify(fresh));
    disk.set(`${STORAGE_PREFIX}garbage`, '{not json');
    const e = env({ disk, t0 });
    await e.start();
    check('90-day clean-up: another account\'s entry older than 90 days is removed unsent; a newer one stays for its viewer', !disk.has(storageKey(old.viewer, CODE, 'w9')) && disk.has(storageKey(old.viewer, CODE, 'w8')) && !disk.has(`${STORAGE_PREFIX}garbage`) && e.sent.length === 0);
  }

  console.log(failures === 0 ? '\nall rate-outbox pins pass' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
