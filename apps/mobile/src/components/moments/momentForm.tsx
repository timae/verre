import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState, useRef } from 'react';
import { Keyboard, type LayoutChangeEvent, Modal, Pressable, TextInput, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { DATE_LOCALE } from '@/lib/locale';
import { usePhoneTokens } from '@/lib/layout';
import { motion, radius, useTheme } from '@/theme';

// Shared moment-form widgets, extracted from create.tsx so the 02f settings
// "Moment details" sheet renders the IDENTICAL pixel-spec controls (DateField,
// NotesField) and reuses the same cover-photo pipeline (fitCover/pickCover).
// Both surfaces collect the same fields — one home keeps them from drifting.

// .disclosure "Add more details" — header bar + a body that EXPANDS DOWN FROM
// the bar (height 0 → measured) and RETRACTS UP INTO it, clipped by
// overflow:hidden. NOT a screen-edge slide (SlideInUp read as "from the top").
// Content stays mounted (measured via onLayout); we animate the wrapper height.
// `onExpanded` fires after the open animation so the screen can scroll it into
// view. Duration = motion.dur3 (the slower tier — the disclosure felt too fast).
export function Disclosure({
  label,
  open,
  onToggle,
  onExpanded,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onExpanded?: () => void;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  // Measured natural height of the content (from an UNCLIPPED inner view, so it
  // reports the real size even while the animated wrapper is at height 0).
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(open ? 1 : 0);
  // Drive the animation from an effect keyed ONLY on open (+ measured height),
  // NOT useDerivedValue — a derived value re-evaluates on every parent re-render
  // (e.g. typing in the fields), which would re-fire onExpanded/scroll. The
  // effect runs once per open/close transition. onExpanded latches via the
  // withTiming completion callback.
  useEffect(() => {
    if (open && contentHeight === 0) return; // wait for the first measurement
    progress.value = withTiming(
      open ? 1 : 0,
      { duration: motion.dur3, easing: Easing.bezier(...motion.ease) },
      (done) => {
        if (done && open && onExpanded) runOnJS(onExpanded)();
      },
    );
    // onExpanded intentionally excluded — callers pass fresh inline fns; we only
    // want this to run on an open/close edge, not when the callback identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contentHeight, progress]);

  const bodyStyle = useAnimatedStyle(() => ({
    height: contentHeight * progress.value,
    opacity: progress.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }],
  }));
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          borderTopWidth: 1, borderTopColor: theme.rule,
          marginTop: 18, paddingTop: 16, paddingBottom: 4,
        }}
      >
        <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{label}</VText>
        <Animated.View style={chevronStyle}>
          <Icon name="chevron-down" size={18} color={theme.inkSoft} />
        </Animated.View>
      </Pressable>
      {/* Clipped wrapper animates height 0↔contentHeight (reveal from the bar).
          When closed it's hidden from the a11y tree so VoiceOver/TalkBack don't
          reach the collapsed fields. */}
      <Animated.View
        style={[{ overflow: 'hidden' }, bodyStyle]}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        {/* Absolutely positioned so its layout is the NATURAL content height,
            independent of the wrapper's animated (possibly 0) height — the
            wrapper measuring its own clipped child returned 0 and the body never
            opened. */}
        <View
          // paddingTop (not marginTop) so the 14px lead spacing is INCLUDED in
          // the measured layout height — otherwise the wrapper (height =
          // contentHeight) clips the last 14px.
          style={{ position: 'absolute', left: 0, right: 0, gap: 14, paddingTop: 14 }}
          onLayout={(e: LayoutChangeEvent) => setContentHeight(e.nativeEvent.layout.height)}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

export function nextFullHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

// The mock's year-less field format ("Fri 20 Jun 19:00" — no separator between
// date and time, just a space). DATE_LOCALE gives region-aware date order in
// English words (see lib/locale.ts); time stays 24h by design regardless of region.
export function formatWhen(d: Date): string {
  const date = d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(DATE_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

// Downscale + recompress rather than rejecting a big photo (a cover never
// needs full resolution). Mirrors the web pipeline (AddWineModal /
// AvatarEditor): resize the long edge to 1200, re-encode JPEG ~0.82. The
// manipulator re-encode also STRIPS EXIF/GPS as a side effect; the server's
// stripJpegMetadata (lib/s3.ts) is the backstop. If 0.82 still exceeds the
// cap (huge dimensions), step quality down.
//
// `maxBytes` is the base64-length ceiling and is per-SURFACE, not universal:
// covers/avatars decode to a ~2MB server cap (MAX_COVER_BYTES), but a WINE
// image is rejected server-side over 1.5MB base64 by sanitizeImage
// (lib/session.ts) — and that rejection is SILENT (returns '', so the wine
// saves with no image). So the impression picker must pass its own smaller cap
// (MAX_WINE_IMAGE_BYTES); a photo between the two caps would otherwise pass the
// client check and lose its image server-side.
export const MAX_COVER_BYTES = 2_600_000; // base64 length; ≈2MB decoded server cap
// A margin under the 1.5MB sanitizeImage cap to leave room for the
// `data:image/jpeg;base64,` prefix and base64 overhead.
export const MAX_WINE_IMAGE_BYTES = 1_400_000;
export async function fitCover(uri: string, srcW: number, srcH: number, maxBytes = MAX_COVER_BYTES): Promise<string | null> {
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
    if (dataUrl.length <= maxBytes) return dataUrl;
  }
  return null;
}

// Launches the photo library, fits the result. Returns the picked image (data
// URL + the original asset uri for an immediate local preview) or null on
// cancel/failure; `failed` distinguishes a real failure (show an error) from a
// user cancel (do nothing). `maxBytes` defaults to the cover cap; the
// impression form passes MAX_WINE_IMAGE_BYTES (see fitCover).
export async function pickCover(maxBytes = MAX_COVER_BYTES): Promise<{ dataUrl: string; previewUri: string } | null | { failed: true }> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1, // full quality from the picker; fitCover does the compression
  }).catch(() => null);
  const asset = result && !result.canceled ? result.assets[0] : null;
  if (!asset?.uri) return null;
  const dataUrl = await fitCover(asset.uri, asset.width ?? 1200, asset.height ?? 1200, maxBytes);
  if (!dataUrl) return { failed: true };
  return { dataUrl, previewUri: asset.uri };
}

// From/To — brand .field box, EMPTY by default (our own field can render
// empty; the OS compact pills couldn't, and allowed no format control). Set
// .field + .select-wrap — a tappable field box that reads like a dropdown
// (value or placeholder + a trailing chevron). Native-chrome dropdown rendered
// as a brand trigger; the actual choosing happens in a sheet. (Extracted from
// add.tsx per the catalog's pending-extraction list.)
export function SelectField({
  value, placeholder, onPress, accessibilityLabel,
}: {
  value: string;
  placeholder: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('formControl');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // Dismiss first so a tap coming FROM a focused text field opens the sheet
      // on the first tap — otherwise keyboardShouldPersistTaps can spend that tap
      // dismissing the keyboard and the open needs a second tap.
      onPress={() => { Keyboard.dismiss(); onPress(); }}
      style={({ pressed }) => ({
        minHeight: surface.height(44), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 14, paddingVertical: surface.paddingY(10), backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
        borderWidth: 1, borderColor: theme.rule, borderRadius: radius.sm,
      })}
    >
      <VText variant="body" surface="formControl" color={value ? 'ink' : 'inkFaint'} numberOfLines={1} style={{ flex: 1 }}>
        {value || placeholder}
      </VText>
      <Icon name="chevron-down" size={18} color={theme.inkSoft} />
    </Pressable>
  );
}

// state shows the year-less mock format + an × to clear. Tapping presents the
// OS INLINE picker (calendar + time) in a content-sized bottom sheet — the
// seed exists only inside the sheet and commits only on Done; swipe-dismiss
// discards.
export function DateField({
  label, value, onChange, defaultValue, minimumDate, maximumDate,
}: {
  label: string;
  value: Date | null;
  onChange: (d: Date | null) => void;
  defaultValue: () => Date;
  // Bound the picker so an invalid window can't be chosen at all (the OS greys
  // out out-of-range dates): To passes minimumDate=From, From passes
  // maximumDate=To. Server is the real authority (applySessionFields), this is
  // the UX guard.
  minimumDate?: Date;
  maximumDate?: Date;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const surface = phone.surface('formControl');
  const [draft, setDraft] = useState<Date | null>(null); // non-null while the sheet is open
  return (
    <View style={{ flex: 1, gap: 7 }}>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{label}</VText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} date and time`}
        accessibilityValue={{ text: value ? formatWhen(value) : 'not set' }}
        onPress={() => {
          // Seed the picker, clamped into [min, max] so it never opens on an
          // out-of-range value (which the OS picker would otherwise snap).
          let seed = value ?? defaultValue();
          if (minimumDate && seed < minimumDate) seed = minimumDate;
          if (maximumDate && seed > maximumDate) seed = maximumDate;
          setDraft(seed);
        }}
        style={({ pressed }) => ({
          minHeight: surface.height(44),
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: surface.paddingY(10),
          backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
          borderWidth: 1,
          borderColor: theme.rule,
          borderRadius: radius.sm,
        })}
      >
        <VText variant="body" surface="formControl" color={value ? 'ink' : 'inkFaint'} numberOfLines={1} style={{ flex: 1 }}>
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
      {/* Content-sized bottom sheet (NOT pageSheet, which fills the screen): a
          dim scrim with a card pinned to the bottom that's only as tall as the
          picker + header. Tap-scrim or Done dismisses. */}
      <Modal
        visible={draft !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDraft(null)}
      >
        <Pressable style={{ flex: 1, backgroundColor: theme.scrim, justifyContent: 'flex-end' }} onPress={() => setDraft(null)}>
          {/* Inner Pressable swallows taps so they don't bubble to the scrim
              and close the sheet. */}
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
              <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
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
                minimumDate={minimumDate}
                maximumDate={maximumDate}
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

// Description textarea (.field, 2 rows) — same focus convention as TextField.
export function NotesField({
  label, placeholder, value, onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('formControl');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  useRegisterInput(inputRef);
  return (
    <View style={{ gap: 7 }}>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{label}</VText>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChange}
        multiline
        placeholder={placeholder}
        placeholderTextColor={theme.inkFaint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...surface.textProps}
        style={{
          minHeight: surface.height(64),
          // Cap the growth: ~2 lines (minHeight) up to ~8, then the field
          // scrolls INTERNALLY instead of ballooning the form taller and taller
          // (a long description would otherwise push content under the sticky
          // footer). A maxHeight'd multiline TextInput scrolls its own content.
          maxHeight: surface.height(225),
          fontFamily: 'InstrumentSans_400Regular',
          fontSize: phone.text('body').fontSize,
          lineHeight: phone.text('body').lineHeight,
          color: theme.ink,
          backgroundColor: theme.surface,
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? theme.accent : theme.rule,
          borderRadius: radius.sm,
          paddingHorizontal: focused ? 13 : 14,
          paddingTop: surface.paddingY(focused ? 9 : 10),
          paddingBottom: surface.paddingY(10),
          textAlignVertical: 'top',
        }}
      />
    </View>
  );
}
