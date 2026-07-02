// Shared session-screen bootstrap: visit → /state poll → per-section merge.
// Extracted from the line-up screen when Compare became the second full-screen
// consumer of the aggregate poll (the impression detail carries its own copy of
// the merge). The rule this encodes (apps/mobile/CLAUDE.md): any screen reading
// the shared /state poll MUST adopt the same per-section lastRef merge — a
// degraded poll section (null) keeps the last good data, never blanks the UI.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getRemovedState,
  getSessionState,
  postVisit,
  type SessionState,
} from './api/sessions';
import { authClient } from './authClient';

export const SESSION_POLL_MS = 5000;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);

// One my-sessions invalidation per code per app run: the invalidation exists
// for the FIRST membership registration (Moments-home pinning); re-entering
// the session screen re-POSTs /visit (cheap, bumps lastseen) but shouldn't
// refetch the whole home list every time. (Line-up ⇄ Compare is an in-screen
// tab swap — it never remounts this hook.)
const invalidatedCodes = new Set<string>();

// Hide-lineup lock: epoch-ms of the reveal time while the gate is still
// closed, else null. Callers apply their own host exemption. Drives the
// line-up's LockCard; Compare's locked empty state consumes it defensively
// (the tabs are hidden under lock, so it's normally unreachable).
export function lockState(meta: SessionState['meta']): number | null {
  if (!meta?.hideLineup || !meta.dateFrom) return null;
  const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60_000;
  return Date.now() < revealAt ? revealAt : null;
}

export function isFatalSessionError(e: unknown): e is ApiError {
  return e instanceof ApiError && FATAL_KINDS.has(e.kind);
}

export type SessionPoll = {
  meta: SessionState['meta'];
  wines: SessionState['wines'];
  ratings: SessionState['ratings'];
  /** The underlying query — isPending/isError for loading + reconnecting affordances. */
  state: ReturnType<typeof useQuery<SessionState>>;
  fatal: ApiError | null;
  /** Banned-vs-kicked copy fork after a removed bounce (web RemovedView parity). */
  removedKind: 'banned' | 'kicked' | null;
  visited: boolean;
  /** Re-runs the visit (Try-again + the focus-recovery path). */
  retryVisit: () => void;
  myIdentityId: string;
  /** The shared TanStack key — optimistic writers must target exactly this. */
  stateKey: (string | undefined)[];
};

export function useSessionPoll(code: string): SessionPoll {
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Per-section graceful degradation (mirrors web SessionShell): a null
  // section from a partially-failed /state keeps the previous data. The ref is
  // KEYED on (code, identity) and checked synchronously during render — the
  // reset effect below lands post-render, and one render of the previous
  // viewer's/session's data (viewer-scoped block-pair arrays included) must
  // never escape.
  const viewKey = `${code}|${myIdentityId}`;
  const emptyState = (): SessionState => ({ meta: null, wines: null, ratings: null });
  const lastRef = useRef<{ key: string; data: SessionState }>({ key: viewKey, data: emptyState() });
  if (lastRef.current.key !== viewKey) lastRef.current = { key: viewKey, data: emptyState() };

  // /state 401s for non-participants — the visit POST registers this user in
  // the session's identities map first. visitAttempt re-runs the effect for
  // retries; the effect also resets all per-session state on a code change.
  const [visited, setVisited] = useState(false);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [removedKind, setRemovedKind] = useState<'banned' | 'kicked' | null>(null);
  const [visitAttempt, setVisitAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setVisited(false);
    setFatal(null);
    setRemovedKind(null);
    lastRef.current = { key: `${code}|${myIdentityId}`, data: emptyState() };
    postVisit(code)
      .then(() => {
        if (cancelled) return;
        setVisited(true);
        // Membership just registered — the Moments home pinning depends on it.
        if (!invalidatedCodes.has(code)) {
          invalidatedCodes.add(code);
          queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const err = e instanceof ApiError ? e : new ApiError('http', 0);
        // A removed/invalid bounce invalidates the dedup: after a kick →
        // rejoin, the next successful visit must refresh Moments-home pinning.
        if (err.kind === 'removed' || err.kind === 'invalid') invalidatedCodes.delete(code);
        setFatal(err);
      });
    return () => { cancelled = true; };
    // myIdentityId in the deps: an in-place identity change must also drop the
    // previous viewer's lastRef (it holds viewer-scoped meta — block-pair
    // arrays), not just re-key the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, visitAttempt, myIdentityId]);

  // A kick is recoverable: rejoining by code clears the server-side kicked
  // marker, but this screen instance may still hold the stale removed state.
  // Re-run the visit whenever the screen regains focus in a recoverable
  // fatal state (never for plain network errors — those have a Try-again).
  const fatalRef = useRef<ApiError | null>(null);
  fatalRef.current = fatal;
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedOnce.current) {
        focusedOnce.current = true;
        return;
      }
      const f = fatalRef.current;
      if (f && (f.kind === 'removed' || f.kind === 'invalid')) setVisitAttempt((n) => n + 1);
    }, []),
  );

  // Banned vs kicked copy (web RemovedView parity).
  useEffect(() => {
    if (fatal?.kind !== 'removed') return;
    let cancelled = false;
    getRemovedState(code)
      .then((s) => { if (!cancelled && (s === 'banned' || s === 'kicked')) setRemovedKind(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fatal, code]);

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    enabled: visited && !fatal,
    refetchInterval: SESSION_POLL_MS,
    retry: (failureCount, error) => !isFatalSessionError(error) && failureCount < 1,
  });

  useEffect(() => {
    if (!isFatalSessionError(state.error)) return;
    if (state.error.kind === 'removed' || state.error.kind === 'invalid') {
      invalidatedCodes.delete(code);
      // Auth-fatal: drop the cached session view — a kicked/banned viewer's
      // screens must not keep serving the pre-bounce data.
      lastRef.current = { key: viewKey, data: emptyState() };
    }
    setFatal(state.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.error]);

  if (state.data) {
    lastRef.current = {
      key: viewKey,
      data: {
        meta: state.data.meta ?? lastRef.current.data.meta,
        wines: state.data.wines ?? lastRef.current.data.wines,
        ratings: state.data.ratings ?? lastRef.current.data.ratings,
      },
    };
  }
  const { meta, wines, ratings } = lastRef.current.data;

  return {
    meta,
    wines,
    ratings,
    state,
    fatal,
    removedKind,
    visited,
    retryVisit: useCallback(() => setVisitAttempt((n) => n + 1), []),
    myIdentityId,
    stateKey: ['session-state', code, myIdentityId],
  };
}
