import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { getFeedItem, setPostPrivacy, type FeedItem } from '@/lib/api/feed';
import { markProfileHeaderStale, refetchFeedCaches, updateFeedCaches } from '@/lib/feedCache';
import { errorText } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { bumpTarget, postPrivacyVersion, privacyTarget, recordMomentPrivacy, recordPostPrivacy, subscribePostPrivacy, writeSuperseded, type PrivacyField } from '@/lib/postPrivacyState';
import { useMeId } from '@/lib/meId';
import { POST_PRIVACY_COPY } from '@/lib/momentVisibilityCopy';
import { postPrivacyOf, withPrivacy, type PrivacyTarget } from '@/lib/postPrivacyPatch';

// The writes of your own posts' switches (Moment Visibility step 3, § 5): the
// ⋯ rows (card and opened post) and the Moment Privacy page's switch. Each one
// acts at once: the own-post store shows the new value, the write goes out,
// every feed cache is patched IN PLACE (never invalidated: lib/feedCache.ts),
// Moment Privacy's copies are re-read (a post doesn't carry the code), your
// profile header is marked stale. Only a post's LATEST tap reconciles.
// 🔒 One post's writes go out ONE AT A TIME (review 2026-11-24): two quick
// taps are two independent statements on the server, and in parallel they
// could land in the reverse order, leaving the app saying the opposite of the
// stored value. Each tap is shown at once and queued behind the one in flight.

const seq = new Map<string, number>();
// One chain of queued taps per post and field: `tail` the write in flight,
// `pending` the taps not yet handled. A failed latest tap reverts to the
// chain's `confirmed` value, never to "the opposite of that tap" (recheck
// 2026-11-24: two failed taps would otherwise leave "hidden" on a post the
// server shows). The chain is dropped after its last tap's handling.
// `confirmed`: the value the server CONFIRMED in this chain, or null when there
// is none to trust: before the chain's first answer (what showed is a guess,
// and a chain can start while an earlier chain's re-read is still out), or
// after an answer was overtaken by another write of the same target. A failure
// with nothing confirmed re-reads the post instead of reverting (Codex
// rechecks 3 and 4).
type Chain = { tail: Promise<unknown>; confirmed: boolean | null; pending: number };
const chains = new Map<string, Chain>();

// `sessionId`: the post's moment (a moment post), so its ⋯ and the moment's
// Moment Privacy page are one target (lib/postPrivacyState.ts).
export async function togglePostPrivacy(queryClient: QueryClient, postId: number, field: PrivacyField, on: boolean, meId: string | null, sessionId: number | null = null): Promise<void> {
  if (!Number.isFinite(postId)) return;
  const epoch = viewerCacheEpoch();
  const k = `${postId}:${field}`;
  const mine = (seq.get(k) ?? 0) + 1;
  seq.set(k, mine);
  let chain = chains.get(k);
  if (!chain) {
    chain = { tail: Promise.resolve(), confirmed: null, pending: 0 };
    chains.set(k, chain);
  }
  const c = chain;
  c.pending += 1;
  const startedAt = Date.now();
  recordPostPrivacy(postId, field, on, startedAt);
  // Both fields: a moment post's Hide from Feed is a per-moment choice the
  // Moment Privacy page shows too (R12; review 2026-11-25). A check-in's costs
  // a mounted page one extra re-read, nothing more.
  const target = privacyTarget(field, sessionId, postId);
  const gen = bumpTarget(target);
  // 🔒 A queued tap re-checks the viewer before it goes out (Codex recheck):
  // after a sign-out it must not run with the next login's cookie.
  const write = c.tail.catch(() => {}).then(() => {
    if (viewerCacheEpoch() !== epoch) throw new Error('signed out');
    return setPostPrivacy(postId, field, on);
  });
  c.tail = write;
  try {
    const value = await write;
    c.confirmed = writeSuperseded(target, gen) ? null : value;
    if (viewerCacheEpoch() !== epoch || seq.get(k) !== mine) return;
    if (writeSuperseded(target, gen)) {
      // Overtaken (lib/postPrivacyState.ts): the answer is never trusted; the
      // post itself is re-read, and every copy.
      bumpTarget(target);
      void rereadOwnPost(postId, field, meId, epoch);
      void refetchFeedCaches(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['moment-visibility'] });
      void markProfileHeaderStale(queryClient, meId);
      return;
    }
    // Stamped AFTER the answer: a fetch that left later carries the new value.
    const at = Date.now();
    recordPostPrivacy(postId, field, value, at);
    await updateFeedCaches(queryClient, (it) => withPrivacy(it, { postId }, field, value, at));
    bumpTarget(target);
    void queryClient.invalidateQueries({ queryKey: ['moment-visibility'] });
    void markProfileHeaderStale(queryClient, meId);
  } catch (e) {
    if (viewerCacheEpoch() !== epoch || seq.get(k) !== mine) return;
    // Overtaken while it failed: re-read the post (Codex recheck); else the
    // last confirmed value.
    if (writeSuperseded(target, gen) || c.confirmed === null) void rereadOwnPost(postId, field, meId, epoch);
    else recordPostPrivacy(postId, field, c.confirmed, Date.now());
    void refetchFeedCaches(queryClient);
    Alert.alert('Couldn’t change it', errorText(e));
  } finally {
    c.pending -= 1;
    if (c.pending === 0 && chains.get(k) === c) chains.delete(k);
  }
}

// 🔒 An overtaken answer is never trusted (Codex recheck 2: the server may have
// run the writes in another order than the app saw them): the post is re-read
// and its value recorded at the read's START (`getFeedItem` stamps it), so only
// a write that started later can outrank it.
async function rereadOwnPost(postId: number, field: PrivacyField, meId: string | null, epoch: number): Promise<void> {
  if (!meId) return;
  try {
    const it = (await getFeedItem(meId, postId)).items[0];
    if (viewerCacheEpoch() !== epoch || !it) return;
    const [served, at] = it.type === 'session' ? [it.session[field], it.session.privacyAt] : [field === 'hiddenFromFeed' ? it.checkin.hiddenFromFeed : undefined, it.checkin.privacyAt];
    if (typeof served === 'boolean' && at != null) recordPostPrivacy(postId, field, served, at);
  } catch {
    // The lists' refetch and the next open read it again.
  }
}

// The Moment Privacy page's switch landed (`me/privacy`): every post of yours
// of that moment (`sessionId`: the page's `me.sessionId`, from the server), in
// every feed cache and in the own-post store. No id (a guest: no posts) →
// nothing to patch. `overtaken`: the page's answer was overtaken
// (lib/postPrivacyState.ts `writeSuperseded`): nothing recorded from it (the
// page re-reads its `me` and records that), the lists re-read instead.
export async function applyMomentPrivacyToFeeds(queryClient: QueryClient, sessionId: number | undefined, field: PrivacyField, on: boolean, meId: string | null, overtaken = false): Promise<void> {
  const at = Date.now();
  if (sessionId == null) return;
  if (overtaken) {
    void refetchFeedCaches(queryClient);
  } else {
    // The moment's record reaches every copy of your post of it, a pinned
    // one no feed page holds any more included (Codex 2026-11-25).
    recordMomentPrivacy(sessionId, field, on, at);
    await updateFeedCaches(queryClient, (it) => withPrivacy(it, { sessionId }, field, on, at));
  }
  void markProfileHeaderStale(queryClient, meId);
}

// The ⋯ row and the status line of one of YOUR posts, re-rendered whenever
// the own-post store moves: Hide from Feed and "Hidden from feeds" (R13: never
// Incognito). No rows = someone else's post, or the flag is off on the server.
export type PrivacyRow = { field: PrivacyField; label: string; on: boolean; onToggle: () => void };
export function usePostPrivacyRow(item: PrivacyTarget | null | undefined): { rows: PrivacyRow[]; line: string | null } {
  const queryClient = useQueryClient();
  const meId = useMeId();
  useSyncExternalStore(subscribePostPrivacy, postPrivacyVersion, postPrivacyVersion);
  const switches = postPrivacyOf(item);
  return {
    rows: switches.map((p) => ({ field: p.field, label: POST_PRIVACY_COPY.hiddenFromFeed.row, on: p.on, onToggle: () => void togglePostPrivacy(queryClient, p.postId, p.field, !p.on, meId, p.sessionId) })),
    line: switches.some((p) => p.on) ? POST_PRIVACY_COPY.hiddenFromFeed.line : null,
  };
}
