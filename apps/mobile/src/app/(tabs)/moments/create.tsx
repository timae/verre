import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider, BottomSheetView } from '@gorhom/bottom-sheet';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/TextField';
import { DateField, NotesField, nextFullHour, pickCover } from '@/components/moments/momentForm';
import { ToggleRow } from '@/components/moments/settingsParts';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { getMyAccount } from '@/lib/api/me';
import { ApiError, createMoment } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { motion, radius, useTheme } from '@/theme';

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

  const onPickCover = async () => {
    setCoverError(null);
    const picked = await pickCover();
    if (!picked) return; // user cancelled
    if ('failed' in picked) {
      setCoverError("Couldn't use that photo — try another.");
      return;
    }
    setCover(picked);
  };

  const onCreate = async () => {
    setError(null);
    // Friendly guard before the request (the picker min/max should make this
    // unreachable, and the server rejects it regardless — this just gives nice
    // copy instead of the raw server string).
    if (dateFrom && dateTo && dateTo < dateFrom) {
      setError('The end time can’t be before the start time.');
      return;
    }
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
        <VText variant="small" color="inkSoft" style={{ marginBottom: 18 }}>
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
        <CoverPicker cover={cover} onPick={onPickCover} onClear={() => { setCover(null); setCoverError(null); }} />
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
          <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
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
            // From can't be after a set To (the picker greys out later dates).
            maximumDate={dateTo ?? undefined}
          />
          <DateField
            label="To"
            value={dateTo}
            onChange={setDateTo}
            defaultValue={() => new Date((dateFrom ?? nextFullHour()).getTime() + 6 * 3600_000)}
            // To can't be before a set From.
            minimumDate={dateFrom ?? undefined}
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
                    <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: on ? theme.accentInk : theme.inkSoft }}>
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
          <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
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
      </ScrollView>

      {/* Sticky Create bar — SOLID theme.bg fill, no gradient fade (Simon's
          call, matching SettingsFooter + add.tsx). Full-width button, 52pt,
          Apple's 16pt gap above the safe-area inset. The error banner lives HERE
          (above the button), not in the scroll body — the body scrolls (small
          screen / "Add more details" expanded) and an error at its end would
          land below the fold; a footer banner is always visible. */}
      <View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingTop: 14, paddingHorizontal: 16, paddingBottom: insets.bottom + 16,
          backgroundColor: theme.bg,
        }}
      >
        {error ? (
          <VText variant="small" style={{ marginBottom: 10, color: theme.critical }}>{error}</VText>
        ) : null}
        <Button title="Create" loadingTitle="Creating…" loading={creating} onPress={onCreate} bar block />
      </View>

      <CategorySheet open={categoryOpen} onClose={() => setCategoryOpen(false)} />
    </View>
    </BottomSheetModalProvider>
  );
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
  const [fullscreen, setFullscreen] = useState(false);
  if (cover) {
    return (
      <View style={{ height: 150, borderRadius: radius.md, overflow: 'hidden', marginBottom: 16 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open cover photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
          <Image source={{ uri: cover.previewUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </Pressable>
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
            backgroundColor: GLASS_FILL,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={14} color="#fff" />
        </Pressable>
        <FullscreenImage uri={cover.previewUri} visible={fullscreen} label="Cover photo" onClose={() => setFullscreen(false)} />
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
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 4 }}>
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
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
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
