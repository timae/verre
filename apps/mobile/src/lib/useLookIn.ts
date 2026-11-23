import { useQuery } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLookIn, getLookInDetails, type LookIn, type LookInAroma, type LookInMember } from './api/moments';
import { ApiError } from './api/sessions';
import { detailsTick, LOOK_IN_QUERY_POLICY, lookInGate, throughGate } from './lookInDetails';
import { lookInRequestPlan } from './lookInLinks';
import { mergeAromas } from './lookInCompare';

// The look-in's reads (Moment Visibility step-2 plan § 4.4, T4). One query per
// OPENING (the moment, and the link handle when opened by link: never the
// token; lib/lookInLinks.ts lookInRequestPlan): the look-in screen and its bottle pages share it and its fetch gate,
// so a bottle page pushed over a paused look-in polls in its place with no
// burst (lib/lookInDetails.ts). 🔒 `retry: false` and no focus / reconnect
// refetch: every attempt goes through the gate, a failing poll waits for the
// next tick (the screen shows ReconnectingBar). Polls only while the screen
// using it is focused (`subscribed`), like the moment's own poll.

export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  return focused;
}

export function useLookIn(momentId: string, via: unknown, handle: unknown) {
  const focused = useScreenFocused();
  // 🔒 The token comes from the in-memory store by the route's handle, and
  // travels only as the X-Verre-Link header (lib/api/moments.ts); `via` in any
  // form without a known handle is a dead link, never an audience read
  // (lookInRequestPlan, unit-tested).
  const { viaLink, token, badLink, key } = lookInRequestPlan(momentId, via, handle);
  const gate = lookInGate(key.join('|'));
  const q = useQuery<LookIn | LookInMember>({
    queryKey: key,
    queryFn: ({ signal }) => throughGate(gate, 'main', () => getLookIn(momentId, token, signal), signal),
    enabled: !badLink && momentId !== '',
    subscribed: focused,
    ...LOOK_IN_QUERY_POLICY,
  });
  return { q, token, badLink, viaLink, gate, focused };
}

// The open Compare cards' aromas, through the scheduler (≤ 10 keys a read, ≤
// one read every 2 s, cards without aromas first: detailsTick). `eligible`:
// the cards a named person flagged `hasAromas` on (a card only hidden people
// rated never asks). An answer is kept whenever it lands (review r1: one read
// per effect run would drop it whenever a card opened meanwhile).
export function useLookInAromas(momentId: string, token: string | null, gate: ReturnType<typeof lookInGate>, eligible: ReadonlySet<string>, focused: boolean) {
  const [open, setOpen] = useState<ReadonlyMap<string, number>>(new Map());
  const [aromas, setAromas] = useState<ReadonlyMap<string, ReadonlyMap<string, LookInAroma[]>>>(new Map());
  const loaded = useRef(new Map<string, number>());
  const inFlight = useRef(false);
  const onOpenChange = useCallback((key: string, isOpen: boolean) => {
    setOpen((prev) => {
      if (isOpen === prev.has(key)) return prev;
      const next = new Map(prev);
      if (isOpen) next.set(key, Date.now()); else next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!focused || open.size === 0) return;
    const tick = () => void detailsTick({
      gate, open, eligible, loaded: loaded.current, inFlight, now: Date.now,
      fetch: async (keys) => {
        const answer = await getLookInDetails(momentId, keys, token);
        if (!answer.member) setAromas((prev) => mergeAromas(prev, answer));
      },
    });
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [focused, open, eligible, momentId, token, gate]);
  return useMemo(() => ({ aromas, onOpenChange }), [aromas, onOpenChange]);
}

// Which refusal a look-in screen shows (the look-in and its bottle pages):
// opened by link → "This link doesn't work" (also a `via=link` screen whose
// handle has no token: never a fallback to the audience); else "This moment
// isn't available". A 429 or another failure only while there is nothing to
// show (with data: ReconnectingBar).
export type LookInFatal = { error: ApiError; copy?: { title: string; body: string } };
export function lookInFatalOf(o: { badLink: boolean; viaLink: boolean; memberGone: boolean; error: unknown; hasData: boolean; member: boolean }): LookInFatal | null {
  const notFound = o.viaLink
    ? { title: 'This link doesn’t work', body: 'It may have been reset or turned off.' }
    : { title: 'This moment isn’t available', body: 'It may have been deleted, or it isn’t open to you any more.' };
  const e = o.error instanceof ApiError ? o.error : null;
  if (o.badLink || o.memberGone || e?.kind === 'not-found') return { error: new ApiError('not-found', 404), copy: notFound };
  if (o.hasData || o.member || !o.error) return null;
  const err = e ?? new ApiError('http', 0);
  if (err.status === 401) return { error: err, copy: { title: 'You’re signed out', body: 'Sign in again.' } };
  if (err.kind === 'rate-limited') return { error: err, copy: { title: 'Can’t open this moment right now', body: 'Try again in a minute.' } };
  return { error: err };
}
