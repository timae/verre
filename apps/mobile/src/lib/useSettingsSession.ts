import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, getSessionState, type SessionMetaView } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';

// Shared session-meta loader for the 02f settings screens (hub + sub-forms).
//
// NO refetchInterval on purpose. The settings screens are pushed OVER the
// line-up, which stays mounted (expo-router doesn't freeze parent screens — no
// freezeOnBlur/enableFreeze anywhere) and keeps polling this exact key every
// 5s. TanStack dedupes by key + shares the cache, so these screens get live
// updates (e.g. the hub's role pill flips on a co-host promotion) for free off
// that one poll — a second interval here would just double the host's Redis
// load. ⚠️ This relies on the parent staying live: if screen-freezing is ever
// enabled, these would only refresh on focus and want their own interval.
//
// Also bounces to the line-up on a fatal auth/existence error: the settings
// screens are reachable via a cold-start deep-link with no prior /visit, where
// /state 401s as `invalid`. Rather than duplicate the line-up's visit + rejoin
// machinery into each settings screen, we send the user to the line-up, which
// owns that flow (it POSTs /visit, then bounces to /join on a hard failure).
export function useSettingsSession(code: string): { meta: SessionMetaView | null; isError: boolean } {
  const router = useRouter();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
  });

  const fatal =
    state.error instanceof ApiError &&
    (state.error.kind === 'invalid' || state.error.kind === 'removed' || state.error.kind === 'not-found');
  useEffect(() => {
    if (fatal) router.replace({ pathname: '/(tabs)/moments/session/[code]', params: { code } });
  }, [fatal, code, router]);

  return { meta: state.data?.meta ?? null, isError: state.isError };
}
