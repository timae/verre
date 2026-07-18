import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { VBar } from '@/components/VBar';
import { ErrorState } from '@/components/ui/ConnectionState';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { ReadCard, SetGroup, SetNav, type SettingsRole } from '@/components/moments/settingsParts';
import { ApiError, deleteMoment } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { DATE_LOCALE } from '@/lib/locale';
import { sessionWhen } from '@/lib/momentFormat';
import { useSettingsSession } from '@/lib/useSettingsSession';
import { sessionHref, tabHomeHref, useSessionTab } from '@/lib/sessionStack';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';

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
  const sessionTab = useSessionTab();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  const [peopleOpen, setPeopleOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Live role pill + People roster via useSettingsSession's OWN focus-gated
  // poll (it no longer rides the line-up's poll — that pauses while blurred
  // under this pushed screen; see the hook header).
  const { meta, isError, isFetching, refetch } = useSettingsSession(code);

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
  // Full start–end range (date · time both ends) when the moment has a set
  // date, matching the line-up "when"; fall back to just the created date when
  // it has no set date (date-less moments carry no time to show).
  const metaDate = sessionWhen(meta?.dateFrom, meta?.dateTo)
    ?? shortDay(meta ? new Date(meta.createdAt).toISOString() : null);

  const confirmDelete = () => {
    // Destructive confirms always NAME what's being deleted (Simon, 2026-07-18).
    Alert.alert(
      meta?.name ? `Delete “${meta.name}”?` : 'Delete this moment?',
      'This ends the moment for everyone and removes it from their list. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMoment(code);
              router.replace(tabHomeHref(sessionTab));
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
                      label="Moment Details"
                      onPress={() => router.push(sessionHref(sessionTab, 'settings/details', { code }))}
                    />
                    <SetNav
                      icon="eyeoff"
                      label="Reveal & Blind"
                      onPress={() => router.push(sessionHref(sessionTab, 'settings/reveal', { code }))}
                    />
                  </SetGroup>
                  <SetGroup>
                    <SetNav icon="share" label="Share Moment" action onPress={() => setInviteOpen(true)} />
                    {/* Delete is strict-host-only (the DELETE handler rejects
                        cohosts on a live-host session — root role model). The
                        orphaned-host recovery path where a cohost CAN delete
                        isn't surfaced here (no design); strict host covers the
                        common case. Cohosts still edit everything else. */}
                    {isSelfHost ? (
                      <SetNav icon="trash" label="Delete Moment" action critical onPress={confirmDelete} />
                    ) : null}
                  </SetGroup>
                </>
              ) : (
                <>
                  <SetGroup>
                    <SetNav icon="user" label="People" onPress={() => setPeopleOpen(true)} />
                  </SetGroup>
                  <SetGroup>
                    <SetNav icon="share" label="Share Moment" action onPress={() => setInviteOpen(true)} />
                    {/* Leave moment has no working endpoint yet (/leave rejects
                        active participants). Disabled until a leave-self route
                        exists. See memory note verre-ios-settings-02f. */}
                    <SetNav icon="back" label="Leave Moment" action critical disabled soon />
                  </SetGroup>
                </>
              )}
            </ScrollView>
          </>
        ) : isError ? (
          // VBar already rendered above — just the body (no second bar).
          <ErrorState
            title="Couldn’t load this moment"
            message="Check your connection and try again."
            onRetry={refetch}
            retrying={isFetching}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator />
          </View>
        )}
      </View>
    </BottomSheetModalProvider>
  );
}

// "Fri 20 Jun" — read-card date (year-less, like the mock). DATE_LOCALE so
// day/month order follows the device region (English words; see lib/locale.ts).
function shortDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
}
