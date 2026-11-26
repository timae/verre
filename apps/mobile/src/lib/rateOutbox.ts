// The rating outbox, bound to the app (tasting-feedback build 1 § 1). The
// logic is pure in lib/rateOutboxCore.ts (units scripts/tests/rate-outbox-units.ts);
// this file only wires it: AsyncStorage, NetInfo (TanStack's onlineManager),
// AppState, the rate POST behind the viewer / auth gate, the query cache, Alert.
//
// 🔒 The ONLY AsyncStorage holder of user content (apps/mobile/CLAUDE.md
// catalog): unsent rating edits, keyed by the viewer's PUBLIC id × moment ×
// wine, inside the app container (deleted with the app). `clearViewerCache()`
// retires the in-memory work only; the stored entries stay for their viewer
// and go out at that viewer's next sign-in. Entries older than 90 days are
// removed unsent (every viewer's, at each launch).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { onlineManager } from '@tanstack/react-query';
import { uuid } from 'expo';
import { useMemo, useSyncExternalStore } from 'react';
import { Alert, AppState } from 'react-native';
import { ApiError, getSessionStateWithin, rateWine, type RatingMeta, type RatingsView, type SessionState } from './api/sessions';
import { authClient } from './authClient';
import { authGeneration, cookieWithheld } from './authGate';
import { markProfileHeaderStale } from './feedCache';
import { meIdOf } from './meId';
import { onViewerCacheClear, queryClient, viewerCacheEpoch } from './query';
import { createRateOutbox, type ReadOutcome, type SessionCheck } from './rateOutboxCore';

const stateKey = (viewer: string, code: string) => ['session-state', code, `u:${viewer}`];
const READ_DEADLINE_MS = 12_000;

export const rateOutbox = createRateOutbox({
  storage: {
    getAllKeys: () => AsyncStorage.getAllKeys(),
    multiGet: (keys) => AsyncStorage.multiGet(keys as string[]),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
    removeItem: (k) => AsyncStorage.removeItem(k),
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  isOnline: () => onlineManager.isOnline(),
  // `unknown` at launch counts as the foreground; only `background` doesn't.
  appActive: () => AppState.currentState !== 'background',
  // A PLAIN UUID (the native generator lib/clientId.ts uses), never
  // newClientId()'s 21-character form, which the server's op id check refuses.
  newOpId: () => uuid.v4(),
  stamp: () => ({ epoch: viewerCacheEpoch(), gen: authGeneration() }),
  stampCurrent: (s) => s.epoch === viewerCacheEpoch() && s.gen === authGeneration(),
  async send(code, body, stamp, stillEligible) {
    let reason: 'signed-out' | 'stale' | 'ineligible' = 'stale';
    // After the cookie read: a withheld or absent cookie, a stamp that moved,
    // or a gate that closed meanwhile (offline, a stop, a pause, a discard)
    // cancels locally (the persisted op stays).
    const res = await rateWine(code, body, {
      beforeSend: (cookieSent) => {
        if (!cookieSent || cookieWithheld()) {
          reason = 'signed-out';
          return false;
        }
        if (stamp.epoch !== viewerCacheEpoch() || stamp.gen !== authGeneration()) return false;
        if (!stillEligible()) {
          reason = 'ineligible';
          return false;
        }
        return true;
      },
    });
    return res.kind === 'cancelled' ? { kind: 'cancelled', reason } : res;
  },
  // The outbox's OWN read (never the screen's shared fetch, whose credential
  // it can't vouch for): ONE deadline over the headers AND the body
  // (getSessionStateWithin aborts on expiry, the runner's retry takes over),
  // and the dispatch stamp re-checked after the cookie read (a moved one is
  // never sent); the core checks it again at completion.
  async readState(_viewer, code, stamp): Promise<ReadOutcome> {
    try {
      const data = await getSessionStateWithin(code, undefined, READ_DEADLINE_MS, (cookieSent) => cookieSent && !cookieWithheld() && stamp.epoch === viewerCacheEpoch() && stamp.gen === authGeneration());
      return { kind: 'ok', ratings: data.ratings, wineIds: data.wines ? data.wines.map((w) => w.id) : null };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.kind === 'not-found') return { kind: 'gone' };
        if (e.kind === 'removed') return { kind: 'removed' };
        if (e.kind === 'invalid') return { kind: 'invalid' };
      }
      if (e instanceof Error && e.message === 'update_required') return { kind: 'update-required' };
      return { kind: 'retry' };
    }
  },
  async confirmSession(viewer): Promise<SessionCheck> {
    try {
      const r = (await authClient.getSession()) as { data?: { user?: { id?: unknown } } | null; error?: unknown };
      if (r.error) return 'unknown';
      if (!r.data) return 'none';
      return meIdOf(r.data) === viewer ? 'same' : 'other';
    } catch {
      return 'unknown';
    }
  },
  // With the auth generation its fetch STARTED under (none known → -1, never current).
  readRatings: (viewer, code) => {
    const q = queryClient.getQueryCache().find<SessionState>({ queryKey: stateKey(viewer, code), exact: true });
    if (!q?.state.data) return undefined;
    return { ratings: q.state.data.ratings, gen: dataGen.get(q.queryHash) ?? -1 };
  },
  // ONE synchronous step with the owner's answer: cancel the in-flight exact
  // read (TanStack reverts it synchronously), recheck the viewer epoch, then
  // patch ONLY the caller's rating in a PRESENT section; an absent section
  // (or no row of the caller's yet) stays as it is and gets a fresh read.
  patchCache(viewer, code, wineId, rating) {
    const key = stateKey(viewer, code);
    const epoch = viewerCacheEpoch();
    void queryClient.cancelQueries({ queryKey: key, exact: true });
    if (viewerCacheEpoch() !== epoch) return;
    const prev = queryClient.getQueryData<SessionState>(key);
    const id = `u:${viewer}`;
    const group = prev?.ratings?.[id];
    if (!prev || !prev.ratings || !group) {
      if (prev && (rating || prev.ratings === null)) void queryClient.invalidateQueries({ queryKey: key, exact: true });
      return;
    }
    const nextRatings: Record<string, RatingMeta> = { ...group.ratings };
    if (rating) nextRatings[wineId] = rating;
    else delete nextRatings[wineId];
    queryClient.setQueryData<SessionState>(key, { ...prev, ratings: { ...prev.ratings, [id]: { ...group, ratings: nextRatings } } });
  },
  afterFirstAck(viewer) {
    void queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    // Your Impressions tile follows (lists plan D12) when you next look at it.
    void markProfileHeaderStale(queryClient, viewer);
  },
  alert(title, message, done) {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    Alert.alert(title, message, [{ text: 'OK', onPress: finish }], { cancelable: true, onDismiss: finish });
  },
  // X as in the Clear confirm: the line-up alias for a hidden bottle.
  label(viewer, code, wineId) {
    const wines = queryClient.getQueryData<SessionState>(stateKey(viewer, code))?.wines;
    const i = wines?.findIndex((w) => w.id === wineId) ?? -1;
    if (!wines || i < 0) return null;
    return wines[i]._blind || !wines[i].name ? `Impression ${i + 1}` : wines[i].name;
  },
  log: (m, d) => console.warn(m, d),
});

// The query cache feeds the owner: a FETCHED ratings section (never our own
// patch: TanStack marks setQueryData `manual`) supersedes the remembered
// answers and gives base-less entries their base; any other session-state
// change re-renders the snapshot readers.
// 🔒 Provenance (Codex P2): every fetch is stamped with the auth generation
// it STARTED under (TanStack's `fetch` action, before the query function reads
// the cookie), and a fetched section carries that stamp; our own patches keep
// the section's. The owner takes a base or a snapshot only from a section of
// the current, confirmed generation.
const fetchGen = new Map<string, number>();
const dataGen = new Map<string, number>();
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'removed') {
    fetchGen.delete(event.query.queryHash);
    dataGen.delete(event.query.queryHash);
    return;
  }
  if (event.type !== 'updated') return;
  const key = event.query.queryKey;
  if (key[0] !== 'session-state') return;
  if (event.action.type === 'fetch') {
    fetchGen.set(event.query.queryHash, authGeneration());
    return;
  }
  if (event.action.type !== 'success') return;
  if (!event.action.manual) dataGen.set(event.query.queryHash, fetchGen.get(event.query.queryHash) ?? -1);
  const viewer = rateOutbox.viewer();
  if (!viewer || key[2] !== `u:${viewer}`) return;
  const data = event.query.state.data as SessionState | undefined;
  if (!event.action.manual && data?.ratings) rateOutbox.onRawSection(viewer, String(key[1]), data.ratings, dataGen.get(event.query.queryHash) ?? -1);
  else rateOutbox.touch();
});
onlineManager.subscribe((online) => rateOutbox.setOnline(online));
AppState.addEventListener('change', (s) => {
  if (s === 'inactive') return;
  rateOutbox.setAppActive(s === 'active');
});
onViewerCacheClear(() => rateOutbox.retireMemory());

// The root layout's signed-in viewer (public id or null): hydrate + run.
export function setRateOutboxViewer(viewer: string | null) {
  rateOutbox.setViewer(viewer);
}

// The owner's store version (re-render on any change).
export function useRateOutboxVersion(): number {
  return useSyncExternalStore(rateOutbox.subscribe, rateOutbox.version);
}

// The line-up's OWN rows and its sort by your score: the viewer's row overlaid
// by the outbox (entries + remembered answers), so an offline Finish never
// leaves your rows looking unrated. Compare and what others see keep the
// server's state (`ratings` itself) until the phone syncs.
export function useOwnRatingsOverlay(code: string, ratings: RatingsView | null, myIdentityId: string): RatingsView | null {
  const ver = useRateOutboxVersion();
  const viewer = myIdentityId.startsWith('u:') ? myIdentityId.slice(2) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (viewer ? rateOutbox.overlay(viewer, code, ratings) : ratings), [viewer, code, ratings, ver]);
}
