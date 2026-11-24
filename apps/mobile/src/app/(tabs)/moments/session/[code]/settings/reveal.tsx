import { useLocalSearchParams } from 'expo-router';
import { BLIND_FEED_REVEAL_NOTE } from '@verre/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { ChoiceChip } from '@/components/ui/ChoiceChip';
import { SettingsScreenFallback, ToggleRow } from '@/components/moments/settingsParts';
import { MY_ACCOUNT_KEY, getMyAccount } from '@/lib/api/me';
import { updateMomentSettings, type MomentSettingsBody, type SessionMetaView } from '@/lib/api/sessions';
import { errorText } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { useSettingsSession } from '@/lib/useSettingsSession';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';

// 02f·3 Moment Setup — pushed full-screen toggles page (renamed from
// "Reveal & Blind"; it now holds format/mechanics settings, not just blind:
// Hide line-up + timing chips, Blind tasting [PRO], Blind for all, and Show
// who brought each impression [PRO]). Saved on change (ruled 2026-11-24, like
// You → Settings → Privacy and Moment Privacy): every switch or chip is ONE
// settings PATCH of that field, shown at once, one save at a time, put back
// when it fails. No footer, so the bottom nav shows.
export default function MomentSetup() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: MY_ACCOUNT_KEY, queryFn: getMyAccount });
  const pro = account.data?.pro ?? false;
  const { meta, isError, isFetching, refetch } = useSettingsSession(code);

  return meta ? (
    <RevealForm
      code={code}
      meta={meta}
      pro={pro}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: ['session-state', code] });
        void queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
      }}
    />
  ) : (
    <SettingsScreenFallback title="Moment Setup" isError={isError} retrying={isFetching} onRetry={refetch} />
  );
}

type Setup = { hideLineup: boolean; hideMinutes: number; blind: boolean; blindForEveryone: boolean; showProvenance: boolean };

function RevealForm({ code, meta, pro, onSaved }: { code: string; meta: SessionMetaView; pro: boolean; onSaved: () => void }) {
  const insets = useSafeAreaInsets();
  // Seeded once from the moment; from then on the page's own copy (the poll's
  // meta may still be a save behind).
  const [setup, setSetup] = useState<Setup>(() => ({
    hideLineup: !!meta.hideLineup,
    hideMinutes: meta.hideLineupMinutesBefore ?? 0,
    blind: !!meta.blind,
    blindForEveryone: !!meta.blindForEveryone,
    // "Show who brought each impression" — default ON, so an absent flag reads as true.
    showProvenance: meta.showProvenance !== false,
  }));
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  // Hide line-up needs a start time (the reveal countdown is relative to From).
  const hasStart = !!meta.dateFrom;

  const save = async (change: Partial<Setup>, body: MomentSettingsBody) => {
    // 🔒 Synchronous: a second tap in the same frame can't start a second save.
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    const before = setup;
    setSetup({ ...setup, ...change });
    const epoch = viewerCacheEpoch();
    try {
      await updateMomentSettings(code, body);
      if (viewerCacheEpoch() !== epoch) return;
      onSaved();
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      setSetup(before);
      Alert.alert('Something went wrong', errorText(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Moment Setup" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: TAB_BAR_CLEARANCE }}
        showsVerticalScrollIndicator={false}
      >
        <ToggleRow
          title="Hide Line-up"
          subtitle="Guests see the line-up at reveal time"
          value={hasStart && setup.hideLineup}
          onChange={(on) => void save({ hideLineup: on }, on ? { hideLineup: true, hideLineupMinutesBefore: setup.hideMinutes } : { hideLineup: false })}
          disabled={!hasStart}
          reason={!hasStart ? 'Needs a start time' : undefined}
          busy={saving}
        />
        {hasStart && setup.hideLineup ? (
          <>
            {/* The chips are how long BEFORE the start the line-up appears
                (revealAt = dateFrom − minutes); ruled 2026-11-11. */}
            <VText variant="small" color="inkSoft" style={{ marginTop: 10 }}>Reveal before the start</VText>
            <View style={{ flexDirection: 'row', gap: 7, marginTop: 6, flexWrap: 'wrap' }}>
              {([['At start', 0], ['15 min', 15], ['30 min', 30], ['60 min', 60]] as const).map(([label, mins]) => (
                <ChoiceChip
                  key={label}
                  label={label}
                  on={setup.hideMinutes === mins}
                  onPress={() => { if (mins !== setup.hideMinutes) void save({ hideMinutes: mins }, { hideLineupMinutesBefore: mins }); }}
                />
              ))}
            </View>
          </>
        ) : null}
        <ToggleRow
          title="Blind Tasting"
          proBadge
          subtitle="Hides what's tasted until you reveal it"
          note={setup.blind ? BLIND_FEED_REVEAL_NOTE : undefined}
          value={setup.blind}
          // Off clears Blind for All too (the server cascades it).
          onChange={(on) => void save(on ? { blind: true } : { blind: false, blindForEveryone: false }, { blind: on })}
          disabled={!pro}
          reason={!pro ? 'Needs PRO' : undefined}
          busy={saving}
        />
        {/* Blind-for-all composes on blind and is NOT pro-gated server-side
            (settings/route.ts; root freemium note) — only flipping a session TO
            blind needs pro. So gate on `!blind` ONLY: a non-pro COHOST on an
            already-pro-blind session must be able to toggle this. Keep the PRO
            badge (the mock shows it — it's a premium feature at the session
            level), but never block on `!pro` here. */}
        {/* Only while Blind Tasting is on (ruled 2026-11-11): it composes on
            blind, and turning blind off clears it. */}
        {setup.blind ? (
          <ToggleRow
            title="Blind for All"
            proBadge
            subtitle="Also hidden from hosts and cohosts. You still choose when to reveal."
            value={setup.blindForEveryone}
            onChange={(on) => void save({ blindForEveryone: on }, { blindForEveryone: on })}
            busy={saving}
          />
        ) : null}
        {/* Show who brought each impression — DEFAULT ON. PRO is needed to
            CHANGE it (symmetric gate, mirrors the server). A non-pro caller
            (host OR free cohost) sees it locked at whatever the host set — which
            can be OFF (a pro host hid it, a free cohost now views it). So the
            locked reason must read right in EITHER state (a "hide it" prompt is
            nonsense when it's already hidden): "Needs PRO" covers both, like
            Blind Tasting's (ruled 2026-11-11). No helper: the title says it. */}
        <ToggleRow
          title="Show Who Brought Each Impression"
          proBadge
          value={setup.showProvenance}
          onChange={(on) => void save({ showProvenance: on }, { showProvenance: on })}
          disabled={!pro}
          reason={!pro ? 'Needs PRO' : undefined}
          busy={saving}
        />
      </ScrollView>
    </View>
  );
}
