import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { SettingsFooter, ToggleRow } from '@/components/moments/settingsParts';
import { getMyAccount } from '@/lib/api/me';
import {
  ApiError,
  updateMomentSettings,
  type MomentSettingsBody,
  type SessionMetaView,
} from '@/lib/api/sessions';
import { useSettingsSession } from '@/lib/useSettingsSession';
import { radius, useTheme } from '@/theme';

const GUTTER = 22;
const FOOT_CLEARANCE = 120;

// 02f·3 Reveal & blind — pushed full-screen toggles page. Hide line-up +
// timing chips, Blind tasting [PRO], Blind for all. Saves the minimal diff vs
// meta, then returns to the Settings hub. Sticky Discard/Save bar (create.tsx
// .vfoot pattern).
export default function RevealBlind() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ['my-account'], queryFn: getMyAccount });
  const pro = account.data?.pro ?? false;
  const { meta, isError } = useSettingsSession(code);

  return meta ? (
    <RevealForm
      code={code}
      meta={meta}
      pro={pro}
      onSaved={() => {
        queryClient.invalidateQueries({ queryKey: ['session-state', code] });
        queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
        router.back();
      }}
      onDiscard={() => router.back()}
    />
  ) : (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Reveal & blind" />
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        {isError ? (
          <VText variant="small" color="inkSoft">Couldn’t load this moment.</VText>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    </View>
  );
}

function RevealForm({
  code, meta, pro, onSaved, onDiscard,
}: {
  code: string;
  meta: SessionMetaView;
  pro: boolean;
  onSaved: () => void;
  onDiscard: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [hideLineup, setHideLineup] = useState(!!meta.hideLineup);
  const [hideMinutes, setHideMinutes] = useState(meta.hideLineupMinutesBefore ?? 0);
  const [blind, setBlind] = useState(!!meta.blind);
  const [blindForEveryone, setBlindForEveryone] = useState(!!meta.blindForEveryone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide line-up needs a start time (the reveal countdown is relative to From).
  const hasStart = !!meta.dateFrom;

  const onSave = async () => {
    setError(null);
    setSaving(true);
    const body: MomentSettingsBody = {};
    if (hideLineup !== !!meta.hideLineup) body.hideLineup = hideLineup;
    if (hideLineup && hideMinutes !== (meta.hideLineupMinutesBefore ?? 0)) body.hideLineupMinutesBefore = hideMinutes;
    if (blind !== !!meta.blind) body.blind = blind;
    if (blindForEveryone !== !!meta.blindForEveryone) body.blindForEveryone = blindForEveryone;
    if (Object.keys(body).length === 0) { onDiscard(); return; }
    try {
      await updateMomentSettings(code, body);
      onSaved();
    } catch (e) {
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : "Couldn't save changes. Check your connection and try again.");
    }
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Reveal & blind" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        showsVerticalScrollIndicator={false}
      >
        <ToggleRow
          title="Hide line-up"
          subtitle="Guests can only see it from the reveal time"
          value={hasStart && hideLineup}
          onChange={setHideLineup}
          disabled={!hasStart}
          reason={!hasStart ? 'Set a start time to enable' : undefined}
        />
        {hasStart && hideLineup ? (
          <View style={{ flexDirection: 'row', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
            {([['At start', 0], ['15 min', 15], ['30 min', 30], ['60 min', 60]] as const).map(([label, mins]) => {
              const on = hideMinutes === mins;
              return (
                <Pressable
                  key={label}
                  onPress={() => setHideMinutes(mins)}
                  style={{ paddingVertical: 7, paddingHorizontal: 13, borderRadius: radius.pill, borderWidth: 1, borderColor: on ? 'transparent' : theme.rule, backgroundColor: on ? theme.accent : theme.bg }}
                >
                  <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 18, color: on ? theme.accentInk : theme.inkSoft }}>{label}</VText>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <ToggleRow
          title="Blind tasting"
          proBadge
          subtitle="Hide each impression until revealed"
          value={blind}
          onChange={(v) => { setBlind(v); if (!v) setBlindForEveryone(false); }}
          disabled={!pro}
          reason={!pro ? 'Upgrade to PRO to enable' : undefined}
        />
        {/* Blind-for-all composes on blind and is NOT pro-gated server-side
            (settings/route.ts; root freemium note) — only flipping a session TO
            blind needs pro. So gate on `!blind` ONLY: a non-pro COHOST on an
            already-pro-blind session must be able to toggle this. Keep the PRO
            badge (the mock shows it — it's a premium feature at the session
            level), but never block on `!pro` here. */}
        <ToggleRow
          title="Blind for all"
          proBadge
          subtitle="Even you cannot see them — you still control reveals"
          value={blind && blindForEveryone}
          onChange={setBlindForEveryone}
          disabled={!blind}
          reason={!blind ? 'Turn on blind tasting first' : undefined}
        />
        <VText variant="caption" color="inkSoft" style={{ lineHeight: 18, marginTop: 18 }}>
          Some options need a start time, or a PRO plan. They unlock automatically once they apply.
        </VText>
        {error ? <VText variant="small" style={{ marginTop: 12, color: theme.critical }}>{error}</VText> : null}
      </ScrollView>

      <SettingsFooter saving={saving} onDiscard={onDiscard} onSave={onSave} bottomInset={insets.bottom} />
    </View>
  );
}
