import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { ApiError, getSessionState } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { GUTTER } from '@/lib/layout';
import { ImpressionForm } from '../add';

export default function EditImpression() {
  const { code: rawCode, wineId: rawWineId } = useLocalSearchParams<{ code: string; wineId: string }>();
  const code = String(rawCode ?? '');
  const wineId = String(rawWineId ?? '');
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  const meta = state.data?.meta ?? null;
  const wines = state.data?.wines ?? null;
  const wine = wines?.find((w) => w.id === wineId) ?? null;
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const isOwnProvider = !!meta && (meta.providerIds ?? []).includes(myIdentityId) && !!wine?.isMine;
  const canEdit = !!wine && !wine._blind && (isHostViewer || isOwnProvider);

  if (!wine || !canEdit) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
        <VBar title="Edit Impression" />
        <CenteredMessage
          pending={state.isPending}
          title={!wine ? 'This impression is gone' : "You can't edit this impression"}
          body={
            !wine
              ? 'It may have been removed from the line-up.'
              : 'Only hosts, co-hosts, or the provider who added it can edit it.'
          }
        />
      </View>
    );
  }

  return (
    <ImpressionForm
      code={code}
      wineCount={wines?.length ?? 0}
      // Position moves ride the host-gated reorder endpoint — hosts/cohosts
      // only (a provider editing their own wine gets no picker, same as add).
      canPosition={isHostViewer}
      mode="edit"
      wineId={wineId}
      initialWine={wine}
      initialPosition={(wines?.findIndex((w) => w.id === wineId) ?? -1) + 1 || undefined}
      wineIds={wines?.map((w) => w.id)}
    />
  );
}
