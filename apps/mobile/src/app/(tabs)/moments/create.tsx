import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider, BottomSheetView } from '@gorhom/bottom-sheet';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { getMyAccount } from '@/lib/api/me';
import { ApiError, createMoment } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { motion, radius, useTheme } from '@/theme';

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
  // Optional dates, finally settled: brand fields are visible from the
  // start AND empty by default (our own field can render empty — the
  // native control couldn't, which drove the earlier switch/placeholder
  // rounds). A seed only appears inside the picker sheet after a
  // deliberate tap, and commits only on Done.
  const [dateFrom, setDateFrom] = useState<Date | null>(null);
  const [dateTo, setDateTo] = useState<Date | null>(null);
  const [hideLineup, setHideLineup] = useState(false);
  const [hideMinutes, setHideMinutes] = useState(0);
  const [blind, setBlind] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);

  // Downscale + recompress rather than rejecting a big photo (a cover never
  // needs full resolution). Mirrors the web pipeline (AddWineModal /
  // AvatarEditor): resize the long edge to 1200, re-encode JPEG ~0.82. The
  // canvas/manipulator re-encode also STRIPS EXIF/GPS as a side effect; the
  // server's stripJpegMetadata (lib/s3.ts) is the backstop on every upload.
  // If 0.82 still exceeds the cap (huge dimensions), step quality down.
  const MAX_COVER_BYTES = 2_600_000; // base64 length; ≈2MB decoded server cap
  const fitCover = async (uri: string, srcW: number, srcH: number): Promise<string | null> => {
    // Clamp the LONG edge to 1200 (web parity); pass the matching axis so a
    // tall portrait isn't left huge. Only downscale, never upscale.
    const resize: ImageManipulator.ActionResize['resize'] =
      srcW >= srcH ? { width: Math.min(1200, srcW) } : { height: Math.min(1200, srcH) };
    for (const quality of [0.82, 0.6, 0.45, 0.32]) {
      const out = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize }],
        { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      ).catch(() => null);
      if (!out?.base64) return null;
      const dataUrl = `data:image/jpeg;base64,${out.base64}`;
      if (dataUrl.length <= MAX_COVER_BYTES) return dataUrl;
    }
    return null;
  };

  const pickCover = async () => {
    setCoverError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1, // full quality from the picker; fitCover does the compression
    }).catch(() => null);
    const asset = result && !result.canceled ? result.assets[0] : null;
    if (!asset?.uri) return;
    const dataUrl = await fitCover(asset.uri, asset.width ?? 1200, asset.height ?? 1200);
    if (!dataUrl) {
      setCoverError("Couldn't use that photo — try another.");
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
        ...(dateFrom ? { dateFrom: dateFrom.toISOString() } : {}),
        ...(dateTo ? { dateTo: dateTo.toISOString() } : {}),
        ...(dateFrom || dateTo ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
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
    // BottomSheetModalProvider INSIDE the screen (see session/[code]/index.tsx)
    // so the @gorhom/bottom-sheet category sheet has a sized provider/portal host.
    <BottomSheetModalProvider>
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
        <CoverPicker cover={cover} onPick={pickCover} onClear={() => { setCover(null); setCoverError(null); }} />
        {coverError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{coverError}</VText>
        ) : null}

        <View style={{ marginBottom: 14 }}>
          <TextField label="Moment name" placeholder="Friday natural wines" value={name} onChangeText={setName} autoCorrect={false} />
        </View>

        {/* "What are you tasting?" — wine-only v1, field per spec but
            Wine is preselected; the others sit in the sheet disabled
            ("soon") and aren't choosable. */}
        <View style={{ gap: 7, marginBottom: 14 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>
            What are you tasting?
          </VText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="What are you tasting? Wine"
            onPress={() => setCategoryOpen(true)}
            style={({ pressed }) => ({
              height: 44,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 14,
              backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
              borderWidth: 1,
              borderColor: theme.rule,
              borderRadius: radius.sm,
            })}
          >
            <VText variant="body">Wine</VText>
            <Icon name="chevron-down" size={18} color={theme.inkSoft} />
          </Pressable>
        </View>

        {/* .trow2-even From–To per the mock — empty brand fields, picker
            sheet on tap. */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
          <DateField
            label="From"
            value={dateFrom}
            onChange={(d) => {
              setDateFrom(d);
              // Hide line-up needs a start time — clearing From retracts the
              // row, so reset its state too (else a stale `true` would ship
              // with no date).
              if (!d) setHideLineup(false);
            }}
            defaultValue={() => nextFullHour()}
          />
          <DateField
            label="To"
            value={dateTo}
            onChange={setDateTo}
            defaultValue={() => new Date((dateFrom ?? nextFullHour()).getTime() + 6 * 3600_000)}
          />
        </View>

        {/* .trow Hide line-up — only meaningful with a start time (the
            reveal countdown is relative to "From"), so the block appears
            once a From date is set. SpawnedRow self-manages the fade-out →
            then-collapse on removal (content below waits for the fade) and
            an accent glow on add. */}
        <SpawnedRow show={!!dateFrom}>
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
        </SpawnedRow>

        {/* .trow Blind tasting [PRO]. No layout animation on INSERT — the
            Hide row's space opens instantly so Blind is already in its
            final (lower) position when Done is tapped, and only the new row
            fades into the gap (no Blind movement on add). On REMOVE the
            collapse is handled by the exiting row holding its space while it
            fades; Blind then settles without a visible slide. */}
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

      {/* .vfoot — sticky Create bar over a bg fade (transparent at top →
          solid bg by 38%, so scrolling content dissolves rather than
          hitting a hard edge). Full-width button, 52pt, Apple's 16pt gap
          above the safe-area inset. */}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} pointerEvents="box-none">
        <LinearGradient
          colors={['transparent', theme.bg]}
          locations={[0, 0.38]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          pointerEvents="none"
        />
        <View style={{ paddingTop: 14, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }} pointerEvents="box-none">
          <Button title="Create" loadingTitle="Creating…" loading={creating} onPress={onCreate} bar block />
        </View>
      </View>

      <CategorySheet open={categoryOpen} onClose={() => setCategoryOpen(false)} />
    </View>
    </BottomSheetModalProvider>
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

// A block that appears/disappears on a user action, with a controlled
// "fade fully, THEN collapse" exit. We can't use Reanimated's exiting
// lifecycle: it detaches the view into an overlay and reclaims its layout
// slot in the SAME frame `show` flips false, so siblings slide up DURING the
// fade — a FadeOut/Keyframe only animates the overlay copy, never the real
// slot. So we keep the row mounted and drive height+opacity ourselves:
//  - ADD: opacity 0→1 (+ accent glow). No height animation — the slot is at
//    full height from frame 1, so siblings are already in their final
//    position and never appear to move; only this row fades in.
//  - REMOVE: opacity 1→0 first (maxHeight held), THEN maxHeight collapses to
//    0 — rows below ease up only after the fade is done.
// maxHeight (vs a measured height) needs no onLayout pass: a large cap lets
// the content size itself open, and animating the cap to 0 collapses it.
const SPAWN_MAX_H = 400; // safely taller than the Hide-line-up block ever is
function SpawnedRow({ show, children }: { show: boolean; children: React.ReactNode }) {
  const { theme } = useTheme();
  // mounted stays true through the exit animation; flipped off when it ends.
  const [mounted, setMounted] = useState(show);
  const opacity = useSharedValue(show ? 1 : 0);
  const maxH = useSharedValue(show ? SPAWN_MAX_H : 0);
  const glow = useSharedValue(0);

  useEffect(() => {
    if (show) {
      setMounted(true);
      maxH.value = SPAWN_MAX_H; // open instantly — siblings are already final, no slide
      opacity.value = withTiming(1, { duration: motion.dur3 });
      glow.value = withSequence(withTiming(1, { duration: motion.dur2 }), withTiming(0, { duration: motion.dur3 * 2 }));
    } else {
      opacity.value = withTiming(0, { duration: motion.dur2 });
      maxH.value = withDelay(
        motion.dur2, // hold full height until the fade finishes, then collapse
        withTiming(0, { duration: motion.dur2 }, (done) => {
          if (done) runOnJS(setMounted)(false);
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const containerStyle = useAnimatedStyle(() => ({ maxHeight: maxH.value, opacity: opacity.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  if (!mounted) return null;
  return (
    // Outer wrapper does NOT clip — it hosts the glow, which is bigger than
    // the row and bleeds over neighbouring content. The inner view keeps
    // overflow:hidden for the height collapse.
    <View>
      {/* Accent glow with a VERTICAL falloff: transparent → tint → tint →
          transparent top-to-bottom, so it's strong through the middle of the
          row and fades out at the top/bottom edges — a hue, not a flat block. */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -44, left: -52, right: -52, bottom: -60 }, glowStyle]}>
        <LinearGradient
          colors={['transparent', theme.accentTint, theme.accentTint, 'transparent']}
          locations={[0, 0.28, 0.72, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ position: 'absolute', inset: 0, borderRadius: radius.lg }}
        />
      </Animated.View>
      <Animated.View style={[{ overflow: 'hidden' }, containerStyle]}>
        {children}
      </Animated.View>
    </View>
  );
}

// "What are you tasting?" picker — brand bottom sheet (same shell as the
// date picker). Wine is the only choosable row; the rest are disabled
// "soon" rows shown so users see what's coming. v1 always commits 'wine'
// (no other category has a flavour set yet), so selecting Wine just closes.
const CATEGORIES: Array<{ key: string; label: string; enabled: boolean }> = [
  { key: 'wine', label: 'Wine', enabled: true },
  { key: 'coffee', label: 'Coffee', enabled: false },
  { key: 'beer', label: 'Beer', enabled: false },
  { key: 'spirits', label: 'Spirits', enabled: false },
  { key: 'food', label: 'Food', enabled: false },
  { key: 'mixed', label: 'Mixed', enabled: false },
];

function CategorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={{ paddingTop: 8, paddingBottom: insets.bottom + 8 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
            What are you tasting?
          </VText>
        </View>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            accessibilityRole="button"
            accessibilityState={{ disabled: !c.enabled, selected: c.key === 'wine' }}
            disabled={!c.enabled}
            onPress={onClose}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 20,
              paddingVertical: 14,
              backgroundColor: pressed && c.enabled ? theme.surfaceSunk : 'transparent',
            })}
          >
            <VText variant="body" color={c.enabled ? 'ink' : 'inkFaint'}>{c.label}</VText>
            {c.key === 'wine' ? (
              <Icon name="check" size={18} color={theme.accent} />
            ) : !c.enabled ? (
              <VText variant="caption" color="inkFaint">Soon</VText>
            ) : null}
          </Pressable>
        ))}
      </BottomSheetView>
    </Sheet>
  );
}

// The mock's year-less field format ("Fri 20 Jun · 19:00"), device-locale
// ordering for the date words.
function formatWhen(d: Date): string {
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

// From/To — brand .field box, EMPTY by default (our own field can render
// empty; the OS compact pills couldn't, and allowed no format control).
// Set state shows the year-less mock format + an × to clear. Tapping
// presents the OS INLINE picker (calendar + time) in a native pageSheet —
// the seed exists only inside the sheet and commits only on Done;
// swipe-dismiss discards.
function DateField({
  label, value, onChange, defaultValue,
}: {
  label: string;
  value: Date | null;
  onChange: (d: Date | null) => void;
  defaultValue: () => Date;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Date | null>(null); // non-null while the sheet is open
  return (
    <View style={{ flex: 1, gap: 7 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>{label}</VText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} date and time`}
        accessibilityValue={{ text: value ? formatWhen(value) : 'not set' }}
        onPress={() => setDraft(value ?? defaultValue())}
        style={({ pressed }) => ({
          height: 44,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
          borderWidth: 1,
          borderColor: theme.rule,
          borderRadius: radius.sm,
        })}
      >
        <VText variant="body" color={value ? 'ink' : 'inkFaint'} numberOfLines={1} style={{ flex: 1 }}>
          {value ? formatWhen(value) : 'Optional'}
        </VText>
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label.toLowerCase()} date`}
            onPress={() => onChange(null)}
            hitSlop={10}
          >
            <Icon name="x" size={13} color={theme.inkFaint} />
          </Pressable>
        ) : null}
      </Pressable>
      {/* Content-sized bottom sheet (NOT pageSheet, which fills the
          screen): a dim scrim with a card pinned to the bottom that's only
          as tall as the picker + header. Tap-scrim or Done dismisses. */}
      <Modal
        visible={draft !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDraft(null)}
      >
        <Pressable style={{ flex: 1, backgroundColor: theme.scrim, justifyContent: 'flex-end' }} onPress={() => setDraft(null)}>
          {/* Inner Pressable swallows taps so they don't bubble to the
              scrim and close the sheet. */}
          <Pressable
            style={{
              backgroundColor: theme.surface,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + 8,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 20,
                paddingTop: 16,
                paddingBottom: 4,
              }}
            >
              <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
                {label}
              </VText>
              <Button
                title="Done"
                size="sm"
                onPress={() => {
                  if (draft) onChange(draft);
                  setDraft(null);
                }}
              />
            </View>
            {draft ? (
              <DateTimePicker
                value={draft}
                mode="datetime"
                display="inline"
                accentColor={theme.accent}
                onValueChange={(_e, d) => { if (d) setDraft(d); }}
                style={{ alignSelf: 'center' }}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
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
            // letterSpacing adds trailing space after the last glyph, which
            // shoves the text optically left — pull the right padding in by
            // that amount so PRO sits centered.
            <View style={{ backgroundColor: theme.accent, borderRadius: radius.xs, paddingVertical: 2, paddingLeft: 6, paddingRight: 4 }}>
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
