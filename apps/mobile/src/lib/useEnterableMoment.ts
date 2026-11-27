import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { mySessionsQueryOptions } from '@/lib/api/sessions';
import { momentEntry } from '@/lib/momentEntry';
import { lookHref, sessionHref, useSessionTab } from '@/lib/sessionStack';

// "Tap a moment in the feed → open it, but ONLY if you were a member" (Simon).
//
// The sleek + SECURE resolution: the join `code` is NEVER in the /api/feed reply
// (it carries only the opaque `sessionId`), so sniffing the feed response yields
// nothing joinable. The code is looked up CLIENT-SIDE from the viewer's OWN
// ['my-sessions'] query (the Moments tab list) — which by construction contains
// only sessions they joined. So a feed post from someone else's moment you were
// never in has no code anywhere in your responses → not enterable. And even if a
// code were somehow reached, /api/session/:code/state 401s a non-participant
// (participantOrBanned) — the client tap is convenience, authorization is
// server-side.
//
// A SUBSCRIBED useQuery, not a bare queryClient.getQueryData peek: a peek is a
// one-shot snapshot, so cards that rendered before the my-sessions fetch
// resolved (cold start into Feed) never re-rendered and the affordance stayed
// missing. The subscription re-renders when the cache fills or a join/create
// invalidation updates it — and self-fetches when cold, instead of depending
// on the Moments tab having mounted first. Same query the Moments tab warms
// (shared mySessionsQueryOptions), so no extra fetch in the common path.
//
// Returns { code, enterable, enter }: `code` is null when the moment isn't in
// the viewer's sessions (not a member, tombstoned, or beyond the recent page).
// Moment Visibility (step-2 plan § 4.3, T7): with a `momentId` (the feed sends
// one only while the viewer may look in, or is in it) the tap opens the
// LOOK-IN instead, whose first read hands a member back to the moment itself.
// `enterable` = the tap does something (lib/momentEntry.ts decides).
export function useEnterableMoment(sessionId: number | null | undefined, momentId?: string | null): {
  code: string | null;
  enterable: boolean;
  enter: () => void;
} {
  const router = useRouter();
  // Stack-aware (proposal 09 §B): from the feed (cards + detail) the session
  // opens UNDER the feed stack, so back returns to the post; from anywhere
  // else it opens on Moments as before.
  const sessionTab = useSessionTab();
  const rows = useQuery(mySessionsQueryOptions()).data?.rows;
  const match = sessionId != null ? rows?.find((r) => r.id === sessionId) : undefined;
  const code = match?.code ?? null;
  const enter = useCallback(() => {
    const to = momentEntry({ code, momentId });
    if (to.kind === 'moment') router.push(sessionHref(sessionTab, '', { code: to.code }));
    else if (to.kind === 'look') router.push(lookHref(sessionTab, '', { momentId: to.momentId }));
  }, [code, momentId, router, sessionTab]);
  return { code, enterable: momentEntry({ code, momentId }).kind !== 'inert', enter };
}
