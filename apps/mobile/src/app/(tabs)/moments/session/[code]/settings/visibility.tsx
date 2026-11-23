import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { OptionSheet } from '@/components/moments/momentForm';
import { ChoiceRow, SetNav, SettingsFooter, SettingsScreenFallback, SetTitle, ToggleRow } from '@/components/moments/settingsParts';
import { VText } from '@/components/ui/VText';
import { getMomentVisibility, lookInLinkAction, momentVisibilityKey, updateMomentVisibility, type MomentVisibilityPatch, type MomentVisibilityView } from '@/lib/api/moments';
import { ApiError } from '@/lib/api/sessions';
import { viewerCacheEpoch } from '@/lib/query';
import { authClient } from '@/lib/authClient';
import { errorText } from '@/lib/errorCopy';
import { FOOT_CLEARANCE, GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { DATE_LOCALE } from '@/lib/locale';
import { AUDIENCE_ORDER, audienceLabel, guestCirclesApply, guestCirclesTitle, widerThan, type Audience } from '@/lib/momentVisibilityCopy';
import { useSettingsSession } from '@/lib/useSettingsSession';

// Moment Visibility (step-2 plan § 4.6, R8 + R9): who can look into this moment
// without the code. Read from the record (GET /api/session/:code/visibility,
// never the cached meta); the host and cohosts edit (`canEdit`), everyone else
// reads it. Discard / Save footer (T9): ONE PATCH of what changed. The Look-In
// Link's actions act at once, each answer replacing the page's copy of the
// settings. A 404 is "the feature is off" (T10): back.
export default function MomentVisibilitySettings() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const { meta } = useSettingsSession(code);
  const q = useQuery({ queryKey: momentVisibilityKey(code), queryFn: () => getMomentVisibility(code), retry: false });
  const featureOff = q.error instanceof ApiError && q.error.kind === 'not-found';
  useEffect(() => { if (featureOff) router.back(); }, [featureOff, router]);
  const hostId = meta?.hostIdentityId ?? (meta?.hostUserId != null ? `u:${meta.hostUserId}` : null);
  const isHost = !!auth && hostId === `u:${auth.user.id}`;
  return q.data ? (
    <BottomSheetModalProvider>
      <VisibilityForm
        code={code}
        initial={q.data}
        who={isHost ? 'host' : 'other'}
        onSaved={(v) => {
          queryClient.setQueryData(momentVisibilityKey(code), v);
          router.back();
        }}
        onLinkChanged={(v) => queryClient.setQueryData(momentVisibilityKey(code), v)}
        onGone={() => router.back()}
        onDiscard={() => router.back()}
      />
    </BottomSheetModalProvider>
  ) : (
    <SettingsScreenFallback title="Moment Visibility" isError={q.isError && !featureOff} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  );
}

function VisibilityForm({ code, initial, who, onSaved, onLinkChanged, onGone, onDiscard }: {
  code: string;
  initial: MomentVisibilityView;
  who: 'host' | 'other';
  onSaved: (v: MomentVisibilityView) => void;
  onLinkChanged: (v: MomentVisibilityView) => void;
  onGone: () => void;
  onDiscard: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The last answer of the server (a link action replaces it) and the edit's draft.
  const [base, setBase] = useState(initial);
  const [visibility, setVisibility] = useState<Audience>(initial.visibility);
  const [igc, setIgc] = useState(initial.includeGuestCircles);
  const [showPlace, setShowPlace] = useState(initial.showPlace);
  const [showDetails, setShowDetails] = useState(initial.showDetails);
  const [sheet, setSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = base.canEdit;
  const frozen = base.frozen;
  // Frozen: only narrower; a switch that is off may not go on.
  const mayTurnOn = (was: boolean) => !frozen || was;

  const onSave = async () => {
    setError(null);
    const patch: MomentVisibilityPatch = {};
    if (visibility !== base.visibility) patch.visibility = visibility;
    if (igc !== base.includeGuestCircles) patch.includeGuestCircles = igc;
    if (showPlace !== base.showPlace) patch.showPlace = showPlace;
    if (showDetails !== base.showDetails) patch.showDetails = showDetails;
    if (Object.keys(patch).length === 0) { onDiscard(); return; }
    setSaving(true);
    // 🔒 A save that lands after a sign-out (or another account) belongs to the
    // previous viewer: nothing of it may reach the cleared cache (Codex r1).
    const epoch = viewerCacheEpoch();
    try {
      const v = await updateMomentVisibility(code, patch);
      if (viewerCacheEpoch() !== epoch) return;
      onSaved(v);
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      setSaving(false);
      if (e instanceof ApiError && e.kind === 'not-found') return onGone();
      setError(errorText(e));
    }
  };
  const linkAct = async (action: 'share' | 'off' | 'reset') => {
    setLinkBusy(true);
    const epoch = viewerCacheEpoch();
    try {
      const v = await lookInLinkAction(code, action);
      // 🔒 The host's link (and its URL) must not reach the next viewer's cache,
      // nor its share sheet open after a sign-out (Codex r1).
      if (viewerCacheEpoch() !== epoch) return;
      setBase(v);
      onLinkChanged(v);
      // iOS shares the URL itself (both fields would show it twice); Android only takes a message.
      if (action === 'share' && v.link?.url) await Share.share(Platform.OS === 'ios' ? { url: v.link.url } : { message: v.link.url }).catch(() => {});
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      if (e instanceof ApiError && e.kind === 'not-found') return onGone();
      Alert.alert('Couldn’t change the link', errorText(e));
    } finally {
      setLinkBusy(false);
    }
  };
  const confirm = (title: string, body: string, label: string, action: 'off' | 'reset') =>
    Alert.alert(title, body, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: 'destructive', onPress: () => void linkAct(action) }]);

  const options = AUDIENCE_ORDER.map((a) => ({
    code: a,
    label: audienceLabel(a, who),
    ...(frozen && widerThan(a, base.visibility) ? { disabled: true, hint: 'Can only be narrowed' } : {}),
  }));
  const link = base.link;
  const since = link?.since ? new Date(link.since).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' }) : null;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Moment Visibility" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: edit ? insets.bottom + FOOT_CLEARANCE : TAB_BAR_CLEARANCE, gap: 28 }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <SetTitle>Who Can Look In</SetTitle>
          <ChoiceRow
            flush
            dropdown={edit}
            label="Visible To"
            value={audienceLabel(visibility, who)}
            accessibilityLabel={`Who can look in: ${audienceLabel(visibility, who)}`}
            busy={saving}
            onPress={edit ? () => setSheet(true) : undefined}
          />
          <VText variant="small" color="inkSoft" style={{ marginTop: 8 }}>
            People who can look in see the line-up, who was there, and the scores of everyone whose own settings allow it. Joining still needs the code.
          </VText>
          {guestCirclesApply(visibility) ? (
            <ToggleRow
              title={guestCirclesTitle(visibility)}
              value={igc}
              onChange={setIgc}
              disabled={!edit || (!igc && !mayTurnOn(base.includeGuestCircles))}
              busy={saving}
            />
          ) : null}
          <ToggleRow title="Show Address" value={showPlace} onChange={setShowPlace} disabled={!edit || (!showPlace && !mayTurnOn(base.showPlace))} busy={saving} />
          <ToggleRow title="Show Description and Event Link" value={showDetails} onChange={setShowDetails} disabled={!edit || (!showDetails && !mayTurnOn(base.showDetails))} busy={saving} />
          {frozen ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 12 }}>
              This moment’s host no longer has an account, so who can look in can only be narrowed.
            </VText>
          ) : null}
        </View>
        {edit && link?.available ? (
          <View>
            <SetTitle>Look-In Link</SetTitle>
            {link.active ? (
              <>
                {since ? <VText variant="small" color="inkSoft">{`Link active since ${since}`}</VText> : null}
                <SetNav bare icon="share" label="Share Link" action busy={linkBusy} onPress={() => void linkAct('share')} />
                <SetNav bare icon="eyeoff" label="Turn Off" action disabled={linkBusy}
                  onPress={() => confirm('Turn off the link?', 'Anyone who has it can no longer look in. Sharing again makes a new link.', 'Turn Off', 'off')} />
                <SetNav bare icon="undo" label="Reset" action critical disabled={linkBusy}
                  onPress={() => confirm('Reset the link?', 'The old link stops working for everyone who has it.', 'Reset', 'reset')} />
              </>
            ) : (
              <>
                <VText variant="small" color="inkSoft">Anyone with the link can look in, even if they aren’t in your circle. Joining still needs the code.</VText>
                <SetNav bare icon="share" label="Share Link" action busy={linkBusy} onPress={() => void linkAct('share')} />
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
      {edit ? <SettingsFooter saving={saving} error={error} onDiscard={onDiscard} onSave={onSave} bottomInset={insets.bottom} /> : null}
      <OptionSheet
        open={sheet}
        title="Who Can Look In"
        options={options}
        selected={visibility}
        onClose={() => setSheet(false)}
        onSelect={(a) => {
          setSheet(false);
          setVisibility(a);
          if (!guestCirclesApply(a)) setIgc(base.includeGuestCircles);
        }}
      />
    </View>
  );
}
