import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { mySessionsQueryOptions } from '@/lib/api/sessions';

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
// Returns { code, enter } where code is null when the moment isn't in the
// viewer's sessions (not a member, tombstoned, or beyond the recent page — all
// correctly "not tappable"). `enter()` navigates into the live session screen.
export function useEnterableMoment(sessionId: number | null | undefined): {
  code: string | null;
  enter: () => void;
} {
  const router = useRouter();
  const rows = useQuery(mySessionsQueryOptions()).data?.rows;
  const match = sessionId != null ? rows?.find((r) => r.id === sessionId) : undefined;
  const code = match?.code ?? null;
  const enter = useCallback(() => {
    if (code) router.push({ pathname: '/moments/session/[code]', params: { code } });
  }, [code, router]);
  return { code, enter };
}
