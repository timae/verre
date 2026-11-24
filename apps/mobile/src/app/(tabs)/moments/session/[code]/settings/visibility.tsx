import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { OptionSheet } from '@/components/moments/momentForm';
import { ChoiceRow, SetNav, SettingsScreenFallback, SetTitle, ToggleRow } from '@/components/moments/settingsParts';
import { Button } from '@/components/ui/Button';
import { InfoTip } from '@/components/ui/InfoTip';
import { VText } from '@/components/ui/VText';
import { getMomentVisibility, lookInLinkAction, momentVisibilityKey, updateMomentVisibility, type MomentVisibilityPatch, type MomentVisibilityView } from '@/lib/api/moments';
import { ApiError } from '@/lib/api/sessions';
import { viewerCacheEpoch } from '@/lib/query';
import { authClient } from '@/lib/authClient';
import { errorText } from '@/lib/errorCopy';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { DATE_LOCALE } from '@/lib/locale';
import { AUDIENCE_MENU, HIDE_HELPER, WHO_CAN_SEE_INFO, audienceLabel, guestCirclesApply, guestCirclesHelper, guestCirclesTitle, widerThan, type Audience } from '@/lib/momentVisibilityCopy';
import { useSettingsSession } from '@/lib/useSettingsSession';

// Moment Privacy (step-2 plan § 4.6, R8 + R9; renamed from Moment Visibility
// and saved on change, ruled 2026-11-24): who can see this moment without the
// code. Read from the record (GET /api/session/:code/visibility, never the
// cached meta); the host and cohosts edit (`canEdit`), everyone else reads it.
// Every change is ONE PATCH of that field, like You → Settings → Privacy: shown
// at once, one save at a time, the saved value back (and a re-read) when it
// fails. No footer, so the bottom nav shows. The View-Only Link's actions act
// at once too, each answer replacing the page's copy. A 404 is "the feature is
// off" (T10): back.
export default function MomentPrivacySettings() {
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
      <PrivacyForm
        code={code}
        served={q.data}
        who={isHost ? 'host' : 'other'}
        onChanged={(v) => queryClient.setQueryData(momentVisibilityKey(code), v)}
        onUnsure={() => void queryClient.invalidateQueries({ queryKey: momentVisibilityKey(code), exact: true })}
        onGone={() => router.back()}
      />
    </BottomSheetModalProvider>
  ) : (
    <SettingsScreenFallback title="Moment Privacy" isError={q.isError && !featureOff} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  );
}

function PrivacyForm({ code, served, who, onChanged, onUnsure, onGone }: {
  code: string;
  /** The query's copy (the server's last answer). */
  served: MomentVisibilityView;
  who: 'host' | 'other';
  onChanged: (v: MomentVisibilityView) => void;
  /** A save without a definite answer may have landed: re-read. */
  onUnsure: () => void;
  onGone: () => void;
}) {
  const insets = useSafeAreaInsets();
  // What the page shows: the served settings, or a change still being saved.
  const [view, setView] = useState(served);
  const [sheet, setSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const busy = useRef(false);
  const queryClient = useQueryClient();
  // A re-read (focus, a save elsewhere) shows through while nothing is in flight.
  useEffect(() => { if (!busy.current) setView(served); }, [served]);
  const edit = served.canEdit;
  const frozen = served.frozen;
  // Frozen: only narrower; a switch that is off on the record may not go on.
  const mayTurnOn = (was: boolean) => !frozen || was;

  // 🔒 A read in flight (the page's own mount read, a foreground refetch) can
  // carry the value from BEFORE a save: cancel it before showing the change
  // and again before writing the answer, like You → Settings → Privacy
  // (review 2026-11-24). The base is the query's CURRENT copy, never a render
  // behind it.
  const key = momentVisibilityKey(code);
  const current = () => queryClient.getQueryData<MomentVisibilityView>(key) ?? served;
  const save = async (patch: MomentVisibilityPatch) => {
    // 🔒 Synchronous: a second tap in the same frame can't start a second save.
    if (busy.current) return;
    if ((Object.keys(patch) as (keyof MomentVisibilityPatch)[]).every((k) => patch[k] === current()[k])) return;
    busy.current = true;
    setSaving(true);
    // 🔒 A save that lands after a sign-out (or another account) belongs to the
    // previous viewer: nothing of it may reach the cleared cache (Codex r1).
    const epoch = viewerCacheEpoch();
    try {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView({ ...current(), ...patch });
      const v = await updateMomentVisibility(code, patch);
      if (viewerCacheEpoch() !== epoch) return;
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView(v);
      onChanged(v);
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      setView(current());
      if (e instanceof ApiError && e.kind === 'not-found') return onGone();
      // A refusal changed nothing; no answer (a timeout, a 5xx) may have saved.
      if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) onUnsure();
      Alert.alert('Something went wrong', errorText(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const linkAct = async (action: 'share' | 'off' | 'reset') => {
    if (busy.current) return;
    busy.current = true;
    setLinkBusy(true);
    const epoch = viewerCacheEpoch();
    try {
      const v = await lookInLinkAction(code, action);
      // 🔒 The host's link (and its URL) must not reach the next viewer's cache,
      // nor its share sheet open after a sign-out (Codex r1).
      if (viewerCacheEpoch() !== epoch) return;
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView(v);
      onChanged(v);
      // iOS shares the URL itself (both fields would show it twice); Android only takes a message.
      if (action === 'share' && v.link?.url) await Share.share(Platform.OS === 'ios' ? { url: v.link.url } : { message: v.link.url }).catch(() => {});
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      if (e instanceof ApiError && e.kind === 'not-found') return onGone();
      Alert.alert('Couldn’t change the link', errorText(e));
    } finally {
      busy.current = false;
      setLinkBusy(false);
    }
  };
  const confirm = (title: string, body: string, label: string, action: 'off' | 'reset') =>
    Alert.alert(title, body, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: 'destructive', onPress: () => void linkAct(action) }]);

  const options = AUDIENCE_MENU.map((a) => ({
    code: a,
    label: audienceLabel(a, who),
    ...(frozen && widerThan(a, served.visibility) ? { disabled: true, hint: 'Can only be narrowed' } : {}),
  }));
  const link = view.link;
  const since = link?.since ? new Date(link.since).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' }) : null;
  const inert = saving || linkBusy;
  // A real button (ruled 2026-11-24: the row didn't read as one); Turn Off and
  // Reset stay quiet rows under it.
  const shareButton = (
    <Button title="Share Link" icon="share" variant="secondary" block loading={linkBusy} disabled={saving} onPress={() => void linkAct('share')} style={{ marginTop: 12, marginBottom: 4 }} />
  );

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Moment Privacy" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: TAB_BAR_CLEARANCE, gap: 28 }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <SetTitle
            info={
              <InfoTip
                minWidth={260}
                accessibilityLabel="What does this do?"
                text={WHO_CAN_SEE_INFO}
              />
            }
          >
            Who Can See This Moment
          </SetTitle>
          <ChoiceRow
            flush
            dropdown={edit}
            label="Visible To"
            value={audienceLabel(view.visibility, who)}
            accessibilityLabel={`Who can see this moment: ${audienceLabel(view.visibility, who)}`}
            busy={saving}
            onPress={edit && !inert ? () => setSheet(true) : undefined}
          />
          {guestCirclesApply(view.visibility) ? (
            <ToggleRow
              title={guestCirclesTitle(view.visibility)}
              subtitle={guestCirclesHelper(view.visibility)}
              value={view.includeGuestCircles}
              onChange={(on) => void save({ includeGuestCircles: on })}
              disabled={!edit || (!view.includeGuestCircles && !mayTurnOn(served.includeGuestCircles))}
              busy={inert}
            />
          ) : null}
          {/* Hide, not Show (ruled 2026-11-24): the switch is ON while the record
              says hidden (`showPlace` false, the default). Frozen: a hidden one
              may not be shown again (mayTurnOn reads the record). */}
          <ToggleRow
            title="Hide Moment Location"
            subtitle={HIDE_HELPER.place}
            value={!view.showPlace}
            onChange={(hide) => void save({ showPlace: !hide })}
            disabled={!edit || (!view.showPlace && !mayTurnOn(served.showPlace))}
            busy={inert}
          />
          <ToggleRow
            title="Hide Description and Event Link"
            subtitle={HIDE_HELPER.details}
            value={!view.showDetails}
            onChange={(hide) => void save({ showDetails: !hide })}
            disabled={!edit || (!view.showDetails && !mayTurnOn(served.showDetails))}
            busy={inert}
          />
          {frozen ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 12 }}>
              This moment’s host no longer has an account, so who can see it can only be narrowed.
            </VText>
          ) : null}
        </View>
        {edit && link?.available ? (
          <View>
            <SetTitle>View-Only Link</SetTitle>
            {link.active ? (
              <>
                {since ? <VText variant="small" color="inkSoft">{`Link active since ${since}`}</VText> : null}
                {shareButton}
                <SetNav bare icon="eyeoff" label="Turn Off" action disabled={inert}
                  onPress={() => confirm('Turn off the link?', 'Anyone who has it can no longer see this moment. Sharing again makes a new link.', 'Turn Off', 'off')} />
                <SetNav bare icon="undo" label="Reset" action critical disabled={inert}
                  onPress={() => confirm('Reset the link?', 'The old link stops working for everyone who has it.', 'Reset', 'reset')} />
              </>
            ) : (
              <>
                <VText variant="small" color="inkSoft">Anyone with the link can see this moment, even if they aren’t in your circle. Joining still needs the code.</VText>
                {shareButton}
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
      <OptionSheet
        open={sheet}
        title="Who Can See This Moment"
        options={options}
        selected={view.visibility}
        onClose={() => setSheet(false)}
        onSelect={(a) => {
          setSheet(false);
          void save({ visibility: a });
        }}
      />
    </View>
  );
}
