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
import { getMomentVisibility, lookInLinkAction, momentVisibilityKey, updateMomentVisibility, updateMyMomentPrivacy, type MomentChoice, type MomentVisibilityPatch, type MomentVisibilityView } from '@/lib/api/moments';
import { ApiError } from '@/lib/api/sessions';
import { viewerCacheEpoch } from '@/lib/query';
import { authClient } from '@/lib/authClient';
import { errorText } from '@/lib/errorCopy';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { DATE_LOCALE } from '@/lib/locale';
import { AUDIENCE_MENU, HIDE_HELPER, OUTSIDE_SUMMARY_LINE, OWN_AUDIENCE_LINK, ownAudienceBlock, audienceSummaryLabel, shownOrHidden, MOMENT_HIDE_FROM_FEED_HELPER, MOMENT_HIDE_FROM_FEED_TITLE, ONLY_INSIDE_HELPER, ONLY_INSIDE_TITLE, WHO_CAN_SEE_INFO, WHO_CAN_SEE_YOU, audienceLabel, guestCirclesApply, guestCirclesHelper, guestCirclesTitle, widerThan, type Audience } from '@/lib/momentVisibilityCopy';
import { getVisibility, VISIBILITY_KEY } from '@/lib/api/settings';
import { sessionHref, useSessionTab } from '@/lib/sessionStack';
import { bumpTarget, lateAnswerMe, privacyTarget, privacyWriteGeneration, recordMomentPrivacy, writeSuperseded } from '@/lib/postPrivacyState';
import { applyMomentPrivacyToFeeds } from '@/lib/postPrivacyActions';
import { useMeId } from '@/lib/meId';
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
// Step 3 (R1, R11, R12): "Who Can See You", your own Incognito for everyone in
// the moment and, signed in with the server's Hide from Feed on, Hide from Feed
// for your post of it (from the GET's `me`; the section hides while `me` is
// null: no record; the second switch while `me.hiddenFromFeed` is absent). Its answer is merged into `me` only. 🔒 An audience or link answer
// carries `me` too, but one whose request left before a newer Only Inside
// write (this page, or a post's ⋯ on any tab: lib/postPrivacyState.ts) keeps
// the `me` the page shows and re-reads once.
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
  const meId = useMeId();
  const router = useRouter();
  const mount = useSessionTab();
  // Your own privacy (R15): only when signed in (a guest's `me` has no moment id).
  const myVis = useQuery({ queryKey: VISIBILITY_KEY, queryFn: getVisibility, enabled: served.me?.sessionId != null, staleTime: 60_000 });
  // The `me` the page shows right now, for an answer that lands late.
  const shown = useRef(view);
  shown.current = view;
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
    const startedGen = privacyWriteGeneration();
    try {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView({ ...current(), ...patch });
      const answer = await updateMomentVisibility(code, patch);
      if (viewerCacheEpoch() !== epoch) return;
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      const { me, reread } = lateAnswerMe(answer.me, shown.current.me, startedGen);
      const v = { ...answer, me };
      setView(v);
      onChanged(v);
      if (reread) void queryClient.refetchQueries({ queryKey: key, exact: true });
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
    const startedGen = privacyWriteGeneration();
    try {
      const answer = await lookInLinkAction(code, action);
      // 🔒 The host's link (and its URL) must not reach the next viewer's cache,
      // nor its share sheet open after a sign-out (Codex r1).
      if (viewerCacheEpoch() !== epoch) return;
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      const { me, reread } = lateAnswerMe(answer.me, shown.current.me, startedGen);
      const v = { ...answer, me };
      setView(v);
      onChanged(v);
      if (reread) void queryClient.refetchQueries({ queryKey: key, exact: true });
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
  // Your own choices (Incognito, Hide from Feed: R11, R12): the same
  // one-save-at-a-time rule; each answer is merged into `me` only, then your
  // posts of this moment follow in every feed cache (lib/postPrivacyActions.ts).
  const saveMe = async (field: MomentChoice, value: boolean) => {
    if (busy.current) return;
    const was = current().me;
    if (!was || was[field] === value) return;
    busy.current = true;
    setSaving(true);
    const epoch = viewerCacheEpoch();
    // One target with this moment's post's ⋯ (lib/postPrivacyState.ts); the
    // moment's id comes from the server (`me.sessionId`, signed in).
    const sessionId = was.sessionId;
    const target = sessionId != null ? privacyTarget(field, sessionId, NaN) : `c${code}:${field}`;
    const gen = bumpTarget(target);
    try {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView({ ...current(), me: { ...was, [field]: value } });
      const on = await updateMyMomentPrivacy(code, field, value);
      if (viewerCacheEpoch() !== epoch) return;
      // Overtaken by a ⋯ tap while in flight (lib/postPrivacyState.ts): the
      // page keeps what it shows and re-reads; the lists are re-read too.
      const overtaken = writeSuperseded(target, gen);
      bumpTarget(target);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      const cur = current();
      const v = overtaken ? cur : { ...cur, me: { ...(cur.me ?? was), [field]: on } };
      setView(v);
      onChanged(v);
      void applyMomentPrivacyToFeeds(queryClient, sessionId, field, on, meId, overtaken);
      if (overtaken) {
        // Never trust an overtaken answer (Codex recheck 2): re-read `me` and
        // record the moment's value at the read's start.
        const readAt = Date.now();
        void queryClient.fetchQuery({ queryKey: key, queryFn: () => getMomentVisibility(code), staleTime: 0 }).then((fresh) => {
          const v = fresh.me?.[field];
          if (viewerCacheEpoch() === epoch && sessionId != null && typeof v === 'boolean') recordMomentPrivacy(sessionId, field, v, readAt);
        }).catch(() => {});
      }
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      setView(current());
      if (e instanceof ApiError && e.kind === 'not-found') return onGone();
      if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) onUnsure();
      Alert.alert('Something went wrong', errorText(e));
    } finally {
      busy.current = false;
      setSaving(false);
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
        {!edit ? (
          // Anyone who can't change it reads a summary (R14): values, no
          // disabled switches, no sheet.
          <View>
            <SetTitle>Who Can See This Moment</SetTitle>
            <VText variant="small" color="inkSoft">{OUTSIDE_SUMMARY_LINE}</VText>
            <ChoiceRow label="Visible To" value={audienceSummaryLabel(view.visibility, view.includeGuestCircles)} valueLines={2} />
            {view.visibility !== 'members' ? (
              <>
                <ChoiceRow label="Moment Location" value={shownOrHidden(view.showPlace)} />
                <ChoiceRow label="Description and Event Link" value={shownOrHidden(view.showDetails)} />
              </>
            ) : null}
          </View>
        ) : (
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
        )}
        {view.me ? (
          <View>
            {/* No ⓘ (ruled 2026-11-25): the switches' own lines say it. */}
            <SetTitle>{WHO_CAN_SEE_YOU}</SetTitle>
            {/* R15: your own account privacy limits who outside sees you by
                name (signed in): the lead, your setting, maybe a note, and the
                link to Account Privacy, opened on the moment's own stack. */}
            {myVis.data ? (() => {
              const own = ownAudienceBlock(myVis.data, view.me.onlyInside);
              return (
                // Room under the link before the switches (device pass 2026-11-25).
                <View style={{ marginBottom: 12 }}>
                  <VText variant="small" color="inkSoft">{own.lead}</VText>
                  <VText variant="body" color="ink" style={{ marginTop: 2 }}>{own.value}</VText>
                  {own.note ? <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>{own.note}</VText> : null}
                  <SetNav bare accent icon="link" trailing="none" label={OWN_AUDIENCE_LINK} onPress={() => router.push(sessionHref(mount, 'settings/my-privacy', { code }), { dangerouslySingular: true })} />
                </View>
              );
            })() : null}
            <ToggleRow
              flush={!myVis.data}
              title={ONLY_INSIDE_TITLE}
              subtitle={ONLY_INSIDE_HELPER}
              value={view.me.onlyInside}
              onChange={(on) => void saveMe('onlyInside', on)}
              busy={inert}
            />
            {view.me.hiddenFromFeed !== undefined ? (
              <ToggleRow
                title={MOMENT_HIDE_FROM_FEED_TITLE}
                subtitle={MOMENT_HIDE_FROM_FEED_HELPER}
                value={view.me.hiddenFromFeed}
                onChange={(on) => void saveMe('hiddenFromFeed', on)}
                busy={inert}
              />
            ) : null}
          </View>
        ) : null}
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
