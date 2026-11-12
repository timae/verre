import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useCallback, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { PEOPLE_KEY, SEARCH_KEY, TASTED_WITH_KEY, type PeoplePage, type PersonRow, type SearchPerson, type TastedWith, type peopleKey } from '@/lib/api/people';
import { BLOCKS_KEY, MUTES_KEY } from '@/lib/api/settings';
import { profileKey, profileQueryOptions, setBlocked, setFollowing, setMuted, type Profile } from '@/lib/api/users';
import { errorText } from '@/lib/errorCopy';
import { refetchNetworkFeed, refetchUserFeed } from '@/lib/feedCache';
import { firstName } from '@/lib/initials';
import { viewerCacheEpoch } from '@/lib/query';

// THE relationship write (You profile, People step): follow / unfollow / mute
// / block / unblock, for the profile's buttons and ⋯ menu, the People bar and
// rows, the Add Friends chips, rows and scan result. One home so every surface
// showing that person agrees, and two surfaces can't race on one person.
//
//   1. ONE BLOCKING in-flight set PER PERSON (a second tap is dropped, never
//      latest-wins), read through useSyncExternalStore (`usePersonBusy`) so
//      every button, chip and row spinner for that person re-renders.
//   2. An optimistic patch of the person's header (['user-profile', id]) and
//      of every people list, search and tasted-with entry for them. Block
//      DROPS them from those (unblock refetches); mute drops them from
//      tasted-with only (lists + search keep muted people, docs/dev/mute.md).
//      On failure only THAT person's fields are put back (pages may have
//      loaded meanwhile: never a whole-cache snapshot). A follow taps the iOS
//      "success" haptic as the button flips (ruled 2026-11-12). An unfollow
//      that went through takes them off every list your follow put them on
//      (`dropUnfollowed`: no undo row, the confirm is the guard; ruled
//      2026-11-12).
//   3. Then the person's header is FETCHED and, when that fetch succeeds, is
//      the truth for their rows (`reconcile`): ok → flags + photo + friends in common as now gated;
//      shell → flags, no photo / friends in common; blocked / gone → out of
//      every list (the silent-200 follow of someone who blocked you,
//      app/api/users/[id]/follow). Cancelled right before that fetch:
//      fetchQuery JOINS a read in flight, and one that started during the
//      write (the profile mounting) would stand in for the post-write read.
//      The network feed and (a follow change) the person's post list refetch
//      in place, as before.
//   4. ONE coalesced trailing refresh ~1 s after the last write settles
//      (`scheduleRefresh`): a follow also moves your own counts and OTHER
//      people's in common, knownCount and friends in common, and who your
//      follows let into an extended circle. Active lists / search /
//      tasted-with refetch (an infinite list: every loaded page), the mounted
//      profile headers (yours included) invalidate; inactive ones go stale.
//      Header GETs share a 60/min per-IP limit (rl:profile), so each write
//      fetches only its target's header itself.
// 🔒 The viewer epoch is checked after every await (a sign-out meanwhile
// cleared this viewer's cache; nothing of theirs may be written back). Never a
// feed-cache invalidate (lib/feedCache.ts).

export type RelOp = 'follow' | 'unfollow' | 'mute' | 'unmute' | 'block' | 'unblock';

// ── 1. The per-person in-flight store ────────────────────────────────────────
const inFlight = new Set<number>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function setBusy(id: number, on: boolean) {
  if (on) inFlight.add(id);
  else inFlight.delete(id);
  listeners.forEach((l) => l());
}
// A synchronous read (the sandbox sim; components use usePersonBusy).
export function isPersonBusy(id: number): boolean {
  return inFlight.has(id);
}
export function usePersonBusy(id: number | null | undefined): boolean {
  const get = useCallback(() => (id == null ? false : inFlight.has(id)), [id]);
  return useSyncExternalStore(subscribe, get, get);
}

// ── 2. Cache patches for one person ──────────────────────────────────────────
export type RowPatch = Partial<Pick<PersonRow, 'isFollowing' | 'followsViewer' | 'viewerMutes' | 'imageUrl' | 'friendsInCommon'>>;

function patchLists(qc: QueryClient, id: number, patch: RowPatch | 'remove', tasted: 'patch' | 'remove' = patch === 'remove' ? 'remove' : 'patch') {
  const row = <T extends { id: number }>(r: T): T => (r.id === id && patch !== 'remove' ? { ...r, ...patch } : r);
  const keep = (r: { id: number }) => patch !== 'remove' || r.id !== id;
  qc.setQueriesData<InfiniteData<PeoplePage>>({ queryKey: PEOPLE_KEY }, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, users: p.users.filter(keep).map(row) })) } : d,
  );
  qc.setQueriesData<SearchPerson[]>({ queryKey: SEARCH_KEY }, (d) => (d ? d.filter(keep).map(row) : d));
  qc.setQueriesData<TastedWith[]>({ queryKey: TASTED_WITH_KEY }, (d) => {
    if (!d) return d;
    if (tasted === 'remove') return d.filter((r) => r.id !== id);
    if (patch === 'remove') return d;
    return d.map((r) => (r.id === id ? { ...r, ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}), ...(patch.followsViewer !== undefined ? { followsViewer: patch.followsViewer } : {}) } : r));
  });
}

// After an unfollow: out of your own Friends and Following and out of anyone's
// "Only People You Know" (known = people you follow), searches included.
// Followers keep them (they still follow you: Follow Back).
function dropUnfollowed(qc: QueryClient, id: number, viewerId: number | null) {
  qc.setQueriesData<InfiniteData<PeoplePage>>(
    {
      queryKey: PEOPLE_KEY,
      predicate: (q) => {
        const [, owner, tab, known] = q.queryKey as ReturnType<typeof peopleKey>;
        return known || (owner === viewerId && tab !== 'followers');
      },
    },
    (d) => (d ? { ...d, pages: d.pages.map((p) => ({ ...p, users: p.users.filter((r) => r.id !== id) })) } : d),
  );
}

function patchHeader(qc: QueryClient, id: number, map: (p: Profile) => Profile) {
  const key = profileKey(id);
  const cur = qc.getQueryData<Profile>(key);
  if (cur) qc.setQueryData<Profile>(key, map(cur));
}

function optimistic(op: RelOp): { header?: (p: Profile) => Profile; rows: RowPatch | 'remove'; tasted?: 'remove' } {
  switch (op) {
    case 'follow':
    case 'unfollow': {
      const on = op === 'follow';
      return { header: (p) => (p.state === 'ok' || p.state === 'shell' ? { ...p, isFollowing: on } : p), rows: { isFollowing: on }, tasted: on ? 'remove' : undefined };
    }
    case 'mute':
    case 'unmute': {
      const on = op === 'mute';
      return { header: (p) => (p.state === 'ok' ? { ...p, viewerMutes: on } : p), rows: { viewerMutes: on }, tasted: on ? 'remove' : undefined };
    }
    case 'block':
      return { rows: 'remove' };
    case 'unblock':
      return { rows: {} };
  }
}

// What a person's header says about their list rows: ok → flags + photo +
// friends in common as now gated; shell → flags, no photo / friends in
// common; blocked / gone → the row goes.
export function rowFromProfile(p: Profile): RowPatch | 'remove' {
  if (p.state === 'blocked' || p.state === 'gone') return 'remove';
  return p.state === 'ok'
    ? { isFollowing: p.isFollowing, followsViewer: p.followsYou, viewerMutes: p.viewerMutes, imageUrl: p.imageUrl, friendsInCommon: p.inCommon?.count ?? 0 }
    : { isFollowing: p.isFollowing, followsViewer: p.followsYou, imageUrl: null, friendsInCommon: null };
}

// The person's header FETCHED after the write → their rows. Only a fetch that
// succeeded: on a failure TanStack keeps the pre-write data, which may show
// what the write just took away.
export type Reconciled = { remove: true } | { remove: false; patch: RowPatch } | null;
function reconcile(qc: QueryClient, id: number, p: Profile): Reconciled {
  const patch = rowFromProfile(p);
  if (patch === 'remove') {
    patchLists(qc, id, 'remove');
    return { remove: true };
  }
  // Tasted-with never lists people you follow or muted (the server's rule).
  patchLists(qc, id, patch, patch.isFollowing || patch.viewerMutes ? 'remove' : 'patch');
  return { remove: false, patch };
}

// ── 4. The coalesced trailing refresh ────────────────────────────────────────
// A header the refresh may skip must have been fetched AFTER every write
// finished: a later write (follow B) can change an earlier target's header
// (A's friends in common). `opsDone` counts finished writes (committed or
// not); `fetchedAt` = the count when a target's header fetch started.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let opsDone = 0;
const fetchedAt = new Map<number, number>();
const REFRESH_AFTER_MS = 1000;
function scheduleRefresh(qc: QueryClient, fetched: { id: number; gen: number } | null) {
  if (fetched) fetchedAt.set(fetched.id, fetched.gen);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // Writes still in flight: their own settle reschedules this.
    if (inFlight.size > 0) return;
    const skip = new Set([...fetchedAt].filter(([, gen]) => gen === opsDone).map(([id]) => id));
    fetchedAt.clear();
    void runRefresh(qc, skip);
  }, REFRESH_AFTER_MS);
}
async function runRefresh(qc: QueryClient, skip: Set<number>) {
  const epoch = viewerCacheEpoch();
  const lists = [PEOPLE_KEY, SEARCH_KEY, TASTED_WITH_KEY];
  await Promise.all(lists.map((queryKey) => qc.cancelQueries({ queryKey })));
  if (viewerCacheEpoch() !== epoch) return;
  // invalidate = refetch the ACTIVE ones now (restarting any read in flight)
  // and mark the inactive ones stale for their next mount. Profile headers
  // are plain queries; a header fetched after the last write is skipped.
  await Promise.allSettled([
    ...lists.map((queryKey) => qc.invalidateQueries({ queryKey })),
    qc.invalidateQueries({ queryKey: ['user-profile'], predicate: (q) => !skip.has(q.queryKey[1] as number) }),
  ]);
}

// ── The write ────────────────────────────────────────────────────────────────
const OPS: Record<RelOp, (id: number) => Promise<void>> = {
  follow: (id) => setFollowing(id, true),
  unfollow: (id) => setFollowing(id, false),
  mute: (id) => setMuted(id, true),
  unmute: (id) => setMuted(id, false),
  block: (id) => setBlocked(id, true),
  unblock: (id) => setBlocked(id, false),
};

// Resolves once the write and its refetches settled. `ok` false = refused
// (already in flight), failed (alerted, fields put back) or signed out
// meanwhile. `viewerId` (you) lets an unfollow leave your own lists; without
// it the trailing refresh takes them off.
export async function relate(qc: QueryClient, id: number, op: RelOp, viewerId?: number | null): Promise<{ ok: boolean; reconciled: Reconciled }> {
  if (inFlight.has(id)) return { ok: false, reconciled: null };
  setBusy(id, true);
  const epoch = viewerCacheEpoch();
  try {
    await Promise.all([
      qc.cancelQueries({ queryKey: profileKey(id), exact: true }),
      ...[PEOPLE_KEY, SEARCH_KEY, TASTED_WITH_KEY].map((queryKey) => qc.cancelQueries({ queryKey })),
    ]);
    if (viewerCacheEpoch() !== epoch) return { ok: false, reconciled: null };
    const before = qc.getQueryData<Profile>(profileKey(id));
    const opt = optimistic(op);
    if (opt.header) patchHeader(qc, id, opt.header);
    patchLists(qc, id, opt.rows, opt.tasted ?? (opt.rows === 'remove' ? 'remove' : 'patch'));
    if (op === 'follow') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    let ok = true;
    try {
      await OPS[op](id);
    } catch (e) {
      ok = false;
      opsDone += 1;
      if (viewerCacheEpoch() !== epoch) return { ok, reconciled: null };
      // Put back only this person's fields the patch touched.
      if (op === 'follow' || op === 'unfollow') {
        const was = op === 'unfollow';
        patchHeader(qc, id, (p) => (p.state === 'ok' || p.state === 'shell' ? { ...p, isFollowing: before && (before.state === 'ok' || before.state === 'shell') ? before.isFollowing : was } : p));
        patchLists(qc, id, { isFollowing: was }, 'patch');
      } else if (op === 'mute' || op === 'unmute') {
        const was = op === 'unmute';
        patchHeader(qc, id, (p) => (p.state === 'ok' ? { ...p, viewerMutes: before?.state === 'ok' ? before.viewerMutes : was } : p));
        patchLists(qc, id, { viewerMutes: was }, 'patch');
      }
      Alert.alert('Something went wrong', errorText(e));
    }
    if (ok) opsDone += 1;
    if (viewerCacheEpoch() !== epoch) return { ok, reconciled: null };
    if (ok && op === 'unfollow') dropUnfollowed(qc, id, viewerId ?? null);
    const follows = op === 'follow' || op === 'unfollow';
    const list = op === 'block' || op === 'unblock' ? BLOCKS_KEY : op === 'mute' || op === 'unmute' ? MUTES_KEY : null;
    await qc.cancelQueries({ queryKey: profileKey(id), exact: true });
    if (viewerCacheEpoch() !== epoch) return { ok, reconciled: null };
    const gen = opsDone;
    const [fresh] = await Promise.allSettled([
      qc.fetchQuery({ ...profileQueryOptions(id), staleTime: 0 }),
      refetchNetworkFeed(qc),
      follows ? refetchUserFeed(qc, id) : null,
      list ? qc.invalidateQueries({ queryKey: list, exact: true }) : null,
    ]);
    if (viewerCacheEpoch() !== epoch) return { ok, reconciled: null };
    if (fresh.status === 'rejected') {
      // No header to go by (429, offline): the trailing refresh re-reads it.
      scheduleRefresh(qc, null);
      return { ok, reconciled: null };
    }
    const reconciled = reconcile(qc, id, fresh.value);
    scheduleRefresh(qc, { id, gen });
    return { ok, reconciled };
  } finally {
    setBusy(id, false);
  }
}

// D7 (ruled 2026-11-12): unfollow always asks; the copy branches on the
// relationship flags alone (never the profile's state: a corrupt tier fails
// closed to a shell for everyone, friends included). Follow acts at once.
export function confirmUnfollow(person: { name: string; followsYou: boolean }, onConfirm: () => void) {
  const first = firstName(person.name);
  if (person.followsYou) {
    Alert.alert(`Remove ${first} as Friend?`, `You’ll stop following ${first}. ${first} still follows you, so you can follow back anytime.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove Friend', style: 'destructive', onPress: onConfirm },
    ]);
    return;
  }
  Alert.alert(`Unfollow ${first}?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Unfollow', style: 'destructive', onPress: onConfirm },
  ]);
}
