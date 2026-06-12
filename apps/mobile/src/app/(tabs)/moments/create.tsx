import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { getMyAccount } from '@/lib/api/me';
import { ApiError, createMoment } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { radius, useTheme } from '@/theme';

const GUTTER = 22;
const FOOT_CLEARANCE = 120; // .vbody bottom padding clears the .vfoot bar

// 02a moment creation, to the tCreate pixel spec: .at-photo cover affordance,
// Moment name, "What are you tasting?" category, .trow2 From–To, Hide
// line-up + .hlchip timing, Blind tasting [PRO], "Add more details"
// disclosure, sticky .vfoot Create bar.
//
// Flagged deviations:
// - Category is wine-only v1: the field renders per spec but is
//   non-interactive (Wine preselected, "More categories soon" caption) —
//   the mock's native <select> returns when a second category goes live.
// - From–To are optional (the mock shows prefilled prototype values): empty
//   fields are tappable placeholders; the first tap seeds a sensible
//   default and shows the OS compact datetime picker (native-chrome), the
//   small × clears back to "no date".
// - No lifespan row (per the mock): native creates default to unlimited
//   server-side.
export default function CreateMoment() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  // `pro` gates the blind toggle (disabled + PRO badge); server 403 backstop.
  const account = useQuery({ queryKey: ['my-account'], queryFn: getMyAccount });
  const pro = account.data?.pro ?? false;

  const [cover, setCover] = useState<{ dataUrl: string; previewUri: string } | null>(null);
  const [name, setName] = useState('');
  // Optional dates use the Reminders pattern: a "When" switch row reveals
  // the pickers (the OS compact control can't render empty, and prefilled
  // values were rejected — the switch is the honest empty state; values
  // only exist after the user opts in). Toggling off keeps the values
  // around but they aren't sent.
  const [hasDates, setHasDates] = useState(false);
  const [dateFrom, setDateFrom] = useState<Date>(() => nextFullHour());
  const [dateTo, setDateTo] = useState<Date>(() => new Date(nextFullHour().getTime() + 6 * 3600_000));
  const [hideLineup, setHideLineup] = useState(false);
  const [hideMinutes, setHideMinutes] = useState(0);
  const [blind, setBlind] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickCover = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.6, // re-encodes to JPEG — keeps phone photos under the 3MB data-URL cap
      base64: true,
    }).catch(() => null);
    const asset = result && !result.canceled ? result.assets[0] : null;
    if (!asset?.base64) return;
    const mime = asset.mimeType && asset.mimeType.startsWith('image/') ? asset.mimeType : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${asset.base64}`;
    // Server cap is 2MB DECODED (≈2.67MB as base64); pre-check below that
    // so nothing passes here only to bounce off uploadImage.
    if (dataUrl.length > 2_600_000) {
      setError('That photo is too large — try a smaller one.');
      return;
    }
    setCover({ dataUrl, previewUri: asset.uri });
  };

  const onCreate = async () => {
    setError(null);
    setCreating(true);
    try {
      const { code } = await createMoment({
        hostDisplayName: auth?.user.name ?? 'Host',
        sessionName: name.trim() || undefined,
        category: 'wine',
        ...(cover ? { coverPhoto: cover.dataUrl } : {}),
        ...(hasDates
          ? {
              dateFrom: dateFrom.toISOString(),
              dateTo: dateTo.toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : {}),
        hideLineup,
        ...(hideLineup ? { hideLineupMinutesBefore: hideMinutes } : {}),
        ...(blind ? { blind: true } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(link.trim() ? { link: link.trim() } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
      router.replace({ pathname: '/(tabs)/moments/session/[code]', params: { code } });
    } catch (e) {
      // Surface the server's own message for any 4xx (validation, pro-gate,
      // rate limit) — only network/5xx get the generic copy.
      const serverMessage = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(
        serverMessage && serverMessage !== 'http'
          ? serverMessage
          : "Couldn't create the moment. Check your connection and try again.",
      );
      setCreating(false);
    }
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Create a moment" />
        {/* .vsub */}
        <VText variant="small" color="inkSoft" style={{ lineHeight: 19, marginBottom: 18 }}>
          Set up a tasting to share with others
        </VText>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <CoverPicker cover={cover} onPick={pickCover} onClear={() => setCover(null)} />

        <View style={{ marginBottom: 14 }}>
          <TextField label="Moment name" value={name} onChangeText={setName} autoCorrect={false} />
        </View>

        {/* "What are you tasting?" — wine-only v1, field per spec but
            non-interactive until a second category goes live. */}
        <View style={{ gap: 7, marginBottom: 14 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>
            What are you tasting?
          </VText>
          <View
            style={{
              height: 44,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 14,
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.rule,
              borderRadius: radius.sm,
            }}
          >
            <VText variant="body">Wine</VText>
            <Icon name="chevron-down" size={18} color={theme.inkFaint} />
          </View>
          <VText variant="caption" color="inkFaint">More categories soon</VText>
        </View>

        {/* Optional dates — Reminders-style switch row revealing the
            .trow2-even From–To compact pickers (native-chrome). */}
        <ToggleRow
          title="When"
          subtitle="Set a start and end time for the moment"
          value={hasDates}
          onChange={setHasDates}
        />
        {hasDates ? (
          // .trow2-even From–To side by side per the mock. flexShrink on
          // the picker is load-bearing: it lets the compact control
          // compress into the half-width column (without it the pills'
          // intrinsic width clips the screen edge).
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 10, marginBottom: 4 }}>
            <DateField label="From" value={dateFrom} onChange={setDateFrom} />
            <DateField label="To" value={dateTo} onChange={setDateTo} />
          </View>
        ) : null}

        {/* .trow Hide line-up */}
        <ToggleRow
          title="Hide line-up"
          subtitle="Keep what's being tasted a surprise until before the start"
          value={hideLineup}
          onChange={setHideLineup}
        />
        {hideLineup ? (
          <View style={{ flexDirection: 'row', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
            {([['At start', 0], ['15 min', 15], ['30 min', 30], ['60 min', 60]] as const).map(([label, mins]) => {
              const on = hideMinutes === mins;
              return (
                <Pressable
                  key={label}
                  onPress={() => setHideMinutes(mins)}
                  style={{
                    paddingVertical: 7,
                    paddingHorizontal: 13,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: on ? 'transparent' : theme.rule,
                    backgroundColor: on ? theme.accent : theme.bg,
                  }}
                >
                  <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 18, color: on ? theme.accentInk : theme.inkSoft }}>
                    {label}
                  </VText>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* .trow Blind tasting [PRO] */}
        <ToggleRow
          title="Blind tasting"
          proBadge
          subtitle="Hide what you're tasting until it's revealed"
          value={blind}
          onChange={setBlind}
          disabled={!pro}
        />

        {/* .disclosure Add more details */}
        <Pressable
          onPress={() => setMoreOpen((o) => !o)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTopWidth: 1,
            borderTopColor: theme.rule,
            marginTop: 18,
            paddingTop: 16,
            paddingBottom: 4,
          }}
        >
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
            Add more details
          </VText>
          <View style={{ transform: [{ rotate: moreOpen ? '180deg' : '0deg' }] }}>
            <Icon name="chevron-down" size={18} color={theme.inkSoft} />
          </View>
        </Pressable>
        {moreOpen ? (
          <View style={{ gap: 14, marginTop: 14 }}>
            <TextField label="Address" placeholder="Where's it happening?" value={address} onChangeText={setAddress} />
            <NotesField label="Description" placeholder="Notes for your guests…" value={description} onChange={setDescription} />
            <TextField
              label="Link"
              placeholder="Menu, event page…"
              value={link}
              onChangeText={setLink}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        ) : null}

        {error ? (
          <VText variant="small" style={{ marginTop: 16, color: theme.critical }}>{error}</VText>
        ) : null}
      </ScrollView>

      {/* .vfoot — sticky Create bar over a bg fade */}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} pointerEvents="box-none">
        <LinearGradient
          colors={['transparent', theme.bg]}
          locations={[0, 0.38]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          pointerEvents="none"
        />
        <View style={{ alignItems: 'center', paddingTop: 14, paddingHorizontal: 18, paddingBottom: insets.bottom + 24 }} pointerEvents="box-none">
          <Button title="Create" loadingTitle="Creating…" loading={creating} onPress={onCreate} style={{ minWidth: 220 }} />
        </View>
      </View>
    </View>
  );
}

function nextFullHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

// .at-photo — dashed add affordance; picked image previews in place
// (.at-photo-set, 150px) with a glass × to clear.
function CoverPicker({
  cover, onPick, onClear,
}: {
  cover: { dataUrl: string; previewUri: string } | null;
  onPick: () => void;
  onClear: () => void;
}) {
  const { theme } = useTheme();
  if (cover) {
    return (
      <View style={{ height: 150, borderRadius: radius.md, overflow: 'hidden', marginBottom: 16 }}>
        <Image source={{ uri: cover.previewUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove cover photo"
          onPress={onClear}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: 'rgba(20,18,15,0.55)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={14} color="#fff" />
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPick}
      style={({ pressed }) => ({
        height: 104,
        borderRadius: radius.md,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: theme.rule,
        backgroundColor: theme.surfaceSunk,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        marginBottom: 16,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name="cam" size={24} color={theme.inkSoft} />
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 18, marginTop: 4 }}>
        Add a cover photo
      </VText>
      <VText variant="caption" color="inkSoft">optional — gives your moment a face</VText>
    </Pressable>
  );
}

// From/To — label above the OS combined datetime control (mode="datetime",
// adjacent date + time pills), half-width columns per the mock. Only
// rendered after the "When" switch opts in, so it always has a value.
function DateField({
  label, value, onChange,
}: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, gap: 7 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>{label}</VText>
      <DateTimePicker
        value={value}
        mode="datetime"
        display="compact"
        // The OS draws the compact pills — shape/typography aren't
        // customizable, only the selection tint.
        accentColor={theme.accent}
        onValueChange={(_e, d) => { if (d) onChange(d); }}
        // Load-bearing: bounds the native control to the column width so
        // it compresses instead of clipping the screen edge.
        style={{ flexShrink: 1 }}
      />
    </View>
  );
}

// .trow — switch rows. Switch itself is native-chrome (OS physics), tinted
// from theme tokens; disabled rows dim per .is-disabled.
function ToggleRow({
  title, subtitle, value, onChange, disabled, proBadge,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  proBadge?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingTop: 18, paddingBottom: 2 }}>
      <View style={{ flexShrink: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }} color={disabled ? 'inkFaint' : 'ink'}>
            {title}
          </VText>
          {proBadge ? (
            <View style={{ backgroundColor: theme.accent, borderRadius: radius.xs, paddingVertical: 2, paddingHorizontal: 6 }}>
              <VText style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 9, lineHeight: 11, letterSpacing: 1.08, color: theme.accentInk }}>
                PRO
              </VText>
            </View>
          ) : null}
        </View>
        <VText variant="caption" color={disabled ? 'inkFaint' : 'inkSoft'} style={{ marginTop: 2, maxWidth: 210 }}>
          {subtitle}
        </VText>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: theme.accent }}
        accessibilityLabel={title}
      />
    </View>
  );
}

// Description textarea (.field, 2 rows) — same focus convention as TextField.
function NotesField({
  label, placeholder, value, onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
}) {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 7 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>{label}</VText>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        placeholder={placeholder}
        placeholderTextColor={theme.inkFaint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          minHeight: 64,
          fontFamily: 'InstrumentSans_400Regular',
          fontSize: 15,
          lineHeight: 21,
          color: theme.ink,
          backgroundColor: theme.surface,
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? theme.accent : theme.rule,
          borderRadius: radius.sm,
          paddingHorizontal: focused ? 13 : 14,
          paddingTop: focused ? 9 : 10,
          paddingBottom: 10,
          textAlignVertical: 'top',
        }}
      />
    </View>
  );
}
