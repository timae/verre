import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { ReadCard, SetGroup, SetNav, type SettingsRole } from '@/components/moments/settingsParts';
import { ApiError, deleteMoment, getSessionState } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';

const GUTTER = 22;

// 02f·1 Settings hub — a pushed full-screen page (not a sheet). Read-card +
// nav rows. People/Share open the existing bottom SHEETS (hosted here via the
// in-screen BottomSheetModalProvider); Moment details / Reveal & blind push
// their own screens; Delete soft-deletes. Host sees the full hub; guests get
// read-card + People + Share + (disabled) Leave.
export default function SettingsHub() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  const [peopleOpen, setPeopleOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    refetchInterval: 5000,
  });
  const meta = state.data?.meta ?? null;

  const hostId = meta?.hostIdentityId ?? (meta?.hostUserId != null ? `u:${meta.hostUserId}` : null);
  const isHostViewer = !!meta && (
    hostId === myIdentityId || (meta.coHostIds ?? []).includes(myIdentityId)
  );
  const isSelfHost = !!hostId && hostId === myIdentityId;
  const hostName = meta?.participants.find((p) => p.id === hostId)?.displayName ?? meta?.host ?? '';
  const myRole: SettingsRole =
    myIdentityId && hostId === myIdentityId ? 'host'
    : (meta?.coHostIds ?? []).includes(myIdentityId) ? 'cohost'
    : (meta?.providerIds ?? []).includes(myIdentityId) ? 'provider'
    : 'taster';
  const metaDate = shortDay(meta?.dateFrom) ?? shortDay(meta ? new Date(meta.createdAt).toISOString() : null);

  const confirmDelete = () => {
    Alert.alert(
      'Delete this moment?',
      'This ends the moment for everyone and removes it from their list. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMoment(code);
              router.replace('/(tabs)/moments');
            } catch (e) {
              const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
              Alert.alert('Could not delete', msg || 'Check your connection and try again.');
            }
          },
        },
      ],
    );
  };

  return (
    // BottomSheetModalProvider hosts the People/Invite sheets in-screen (same
    // per-screen provider pattern as the line-up — a root provider's gorhom host
    // gets zero height across the Stack boundary).
    <BottomSheetModalProvider>
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title="Settings" />
        </View>
        {meta ? (
          <>
            <PeopleSheet
              open={peopleOpen}
              onClose={() => setPeopleOpen(false)}
              code={code}
              meta={meta}
              myIdentityId={myIdentityId}
              onInvite={() => setInviteOpen(true)}
            />
            <InviteSheet
              open={inviteOpen}
              onClose={() => setInviteOpen(false)}
              code={code}
              momentName={meta.name}
              // Block-scrub before deriving "Joined" (mirrors the line-up): the
              // full participant list ships; a blocked pair must not light up.
              participantIds={
                new Set(
                  (meta.participants ?? [])
                    .filter((p) => !meta.viewerBlocksOut.includes(p.id) && !meta.viewerBlocksIn.includes(p.id))
                    .map((p) => p.id),
                )
              }
            />
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
              showsVerticalScrollIndicator={false}
            >
              <ReadCard
                name={meta.name || 'Untitled moment'}
                metaLine={`Hosted by ${isSelfHost ? 'you' : hostName}${metaDate ? ` · ${metaDate}` : ''}`}
                role={myRole}
              />
              {isHostViewer ? (
                <>
                  <SetGroup>
                    <SetNav icon="user" label="People" onPress={() => setPeopleOpen(true)} />
                    <SetNav
                      icon="edit"
                      label="Moment details"
                      onPress={() => router.push({ pathname: '/(tabs)/moments/session/[code]/settings/details', params: { code } })}
                    />
                    <SetNav
                      icon="eyeoff"
                      label="Reveal & blind"
                      onPress={() => router.push({ pathname: '/(tabs)/moments/session/[code]/settings/reveal', params: { code } })}
                    />
                  </SetGroup>
                  <SetGroup>
                    <SetNav icon="share" label="Share moment" action onPress={() => setInviteOpen(true)} />
                    {/* Delete is strict-host-only (the DELETE handler rejects
                        cohosts on a live-host session — root role model). The
                        orphaned-host recovery path where a cohost CAN delete
                        isn't surfaced here (no design); strict host covers the
                        common case. Cohosts still edit everything else. */}
                    {isSelfHost ? (
                      <SetNav icon="trash" label="Delete moment" action critical onPress={confirmDelete} />
                    ) : null}
                  </SetGroup>
                </>
              ) : (
                <>
                  <SetGroup>
                    <SetNav icon="user" label="People" onPress={() => setPeopleOpen(true)} />
                  </SetGroup>
                  <SetGroup>
                    <SetNav icon="share" label="Share moment" action onPress={() => setInviteOpen(true)} />
                    {/* Leave moment has no working endpoint yet (/leave rejects
                        active participants). Disabled until a leave-self route
                        exists. See memory note verre-ios-settings-02f. */}
                    <SetNav icon="back" label="Leave moment" action critical disabled soon />
                  </SetGroup>
                </>
              )}
            </ScrollView>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {state.isError ? (
              <VText variant="small" color="inkSoft">Couldn’t load this moment.</VText>
            ) : (
              <ActivityIndicator />
            )}
          </View>
        )}
      </View>
    </BottomSheetModalProvider>
  );
}

// "Fri 20 Jun" — read-card date (year-less, like the mock).
function shortDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
