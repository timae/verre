import { isPublicUserId } from '@verre/core';

// The root layout's boot decisions as PURE functions (unit-tested under tsx:
// scripts/tests/boot-gate-units.ts), so the stale-session rule can't drift
// from what `_layout.tsx` renders.
//
// 🔒 A cached Better Auth session whose `user.id` isn't a PUBLIC id is STALE:
// written before the server switched to public ids (public-user-ids § 6). It
// counts as not yet known. Rendering from it would mount the tabs on the
// integer (`/api/users/<int>` 400s, own-id matches fail), then switch id with
// the tabs mounted (`_layout.tsx` assumes a user never changes X → Y without
// passing through signed-out). And when that first get-session fails with
// anything but a 401, Better Auth KEEPS the cached data and sets `isPending:
// false`, which the old bare `!isPending` term read as "resolved": the stack
// opened with no route group. A signed-out launch (`session == null`) is never
// stale, so it still resolves and the update gate still opens.
export type BootSession = { user?: { id?: unknown } | null } | null | undefined;

export type BootInput = {
  session: BootSession;
  isPending: boolean;
  resolvedOnce: boolean;
  waitedTooLong: boolean;
};

export function bootState({ session, isPending, resolvedOnce, waitedTooLong }: BootInput) {
  const stale = session != null && !isPublicUserId(session.user?.id);
  // A session restored from this install's own cache counts as known (the
  // Expo client keeps it pending until the heartbeat answers), unless stale.
  const cachedSession = session != null && !stale;
  const sessionResolved = !stale && (!isPending || resolvedOnce || cachedSession);
  const splashCanHide = !isPending || resolvedOnce || cachedSession || waitedTooLong;
  // The cache-clear effect's viewer: null while stale (nothing is mounted on it).
  const viewerId = stale ? null : ((session?.user?.id as string | undefined) ?? null);
  return { stale, cachedSession, sessionResolved, splashCanHide, viewerId, signedIn: sessionResolved && session != null };
}

// `resolvedOnce` flips on the first settled, non-stale answer.
export const marksResolved = (isPending: boolean, stale: boolean) => !isPending && !stale;

// What the root renders: the splash (nothing), the update screen IN PLACE of
// the neutral screen (🔒 a 426 that arrives while the session is unknown or
// stale must still show: no navigator is mounted to route into), the neutral
// screen, or the Stack.
export function bootScreen(s: { splashCanHide: boolean; sessionResolved: boolean; updatePending: boolean }): 'splash' | 'update' | 'neutral' | 'stack' {
  if (!s.splashCanHide) return 'splash';
  if (!s.sessionResolved) return s.updatePending ? 'update' : 'neutral';
  return 'stack';
}

// While stale the app retries get-session itself (Better Auth refetches only
// on foreground or a network change). 🔒 Only when NOTHING is in flight
// (`!isPending && !isRefetching`): Better Auth's refetch cancels the request
// in flight, so a timer running during one would keep killing the very
// request that would recover; the layout clears the timer the moment a
// request starts. Fires after a settled failure AND after a settled 200 that
// still carries an integer. Not while an update is pending (no point).
export function shouldRetryStale(s: { stale: boolean; isPending: boolean; isRefetching: boolean; updatePending: boolean }): boolean {
  return s.stale && !s.isPending && !s.isRefetching && !s.updatePending;
}

// 2 s, 4 s, 8 s, 16 s, then every 30 s, counted from each settle.
export const staleRetryDelayMs = (attempt: number) => Math.min(30_000, 2_000 * 2 ** attempt);
