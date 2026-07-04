import { useFocusEffect, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, getSessionState, type SessionMetaView } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';

const SETTINGS_POLL_MS = 5000;

// Shared session-meta loader for the 02f settings screens (hub + sub-forms).
//
// OWNS its own focus-gated poll. Originally these screens rode the line-up's
// poll for free (pushed OVER it, same query key, TanStack shares the cache) —
// but the line-up now pauses its poll while blurred (`useSessionPoll`
// `subscribed: screenFocused`), and a settings screen pushed on top BLURS the
// line-up, so that shared poll stops exactly when settings is showing. So this
// hook polls in its own right, gated on ITS focus the same way: `subscribed`
// drops the observer while blurred (no interval, cache stays readable),
// refocus resubscribes + refetches. When BOTH are focused (impossible — one
// covers the other) TanStack would dedupe to one interval anyway; in practice
// exactly one of the two polls is live at a time, so the host's Redis load is
// unchanged from before.
//
// Also bounces to the line-up on a fatal auth/existence error: the settings
// screens are reachable via a cold-start deep-link with no prior /visit, where
// /state 401s as `invalid`. Rather than duplicate the line-up's visit + rejoin
// machinery into each settings screen, we send the user to the line-up, which
// owns that flow (it POSTs /visit, then bounces to /join on a hard failure).
export function useSettingsSession(code: string): {
  meta: SessionMetaView | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const router = useRouter();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  const [screenFocused, setScreenFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      return () => setScreenFocused(false);
    }, []),
  );

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    subscribed: screenFocused,
    refetchInterval: SETTINGS_POLL_MS,
  });

  const fatal =
    state.error instanceof ApiError &&
    (state.error.kind === 'invalid' || state.error.kind === 'removed' || state.error.kind === 'not-found');
  useEffect(() => {
    if (fatal) router.replace({ pathname: '/(tabs)/moments/session/[code]', params: { code } });
  }, [fatal, code, router]);

  // Only a network/5xx (`http`) error survives as `isError` here — the fatal
  // kinds bounce above. So Retry is the right affordance for the error the
  // settings ErrorState shows.
  return { meta: state.data?.meta ?? null, isError: state.isError, isFetching: state.isFetching, refetch: () => state.refetch() };
}
