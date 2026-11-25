import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, View, type TextInputInstance, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { Disclosure, MAX_COVER_BYTES, NotesField, pickPhoto } from '@/components/moments/momentForm';
import { BottlePicker, type PickerState } from '@/components/catalog/BottlePicker';
import { AddSearchScreen } from '@/components/catalog/BottleSearch';
import { Gone } from '@/components/catalog/pickerParts';
import { getFlow } from '@/lib/pickerFlow';
import type { ProductHit } from '@/lib/api/catalog';
import { newClientId } from '@/lib/clientId';
import type { BottleLabel } from '@/lib/catalogChoice';
import { clearCheckinDraft, getCheckinDraft, nextCheckinDraft, setCheckinDraft } from '@/lib/checkinDraft';
import { checkinHref, useSessionTab, type FlowDest } from '@/lib/sessionStack';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// Standalone check-in create, STAGE 1 of 2: the details (Simon's two-stage
// ruling, 2026-07-08 — "first you add the details, then you rate it and check
// it in"). The bottle first, picked from the catalogue inline (ADR-0009), then
// the photo, where you had it and the bottle's own fields; "Rate It" hands off to
// stage 2 (`./rate`), which owns score/structure/notes and the final POST.
// The hand-off travels through lib/checkinDraft.ts (the photo data URL is far
// too big for route params). A pushed screen per the 02b·add ruling; the
// sticky "Rate It" bar replaces the bottom nav (tabs layout hides the pill on
// /feed/check-in*).
//
// No designed mock exists for the from-scratch flow (the ciSheet is the quick
// prefilled variant, reserved for "Had it too") — the layout mirrors 02b·add's
// field language, all shared primitives.
//
// Photo cap: MAX_COVER_BYTES, NOT the session wine cap — the check-in's photo
// (a PATCH after the post) uploads through the s3 pipeline (~2MB decoded), not
// session.ts sanitizeImage (1.5MB).

type PhotoState = { dataUrl: string; previewUri: string } | null;

const CHECKIN_DEST: FlowDest = { kind: 'checkin' };

// Check In's FIRST screen: the one field (ruled 2026-11-22: a pick opens its
// details on a screen of their own, `./wine`, so back returns here).
export default function CheckinSearch() {
  const mount = useSessionTab();
  // A mount of the search IS a new check-in (the details and the rate stage
  // sit above it). Clear a draft left by an ABANDONED earlier one: backing out
  // at the rate stage leaves the old rating in the store, and the details'
  // preserve-prev read would inherit it into the next check-in (codex P1).
  useEffect(() => {
    clearCheckinDraft(mount.tab);
  }, [mount.tab]);
  return <AddSearchScreen title="Check In" scope={null} dest={CHECKIN_DEST} />;
}

// Check In's details (`./wine`): the pick the search (or the catalogue pages)
// put on the flow, then the photo, where you had it and the bottle's own
// fields; "Rate It" hands off to the rate stage. A cold link without its flow
// reads "This isn't available any more".
export function CheckinDetails() {
  const { key: rawKey } = useLocalSearchParams<{ key?: string }>();
  const key = typeof rawKey === 'string' ? rawKey : '';
  const [initial] = useState(() => getFlow<unknown, unknown, ProductHit>(key)?.choice ?? null);
  if (!initial) return <Gone />;
  return <CheckinForm initial={initial} />;
}

function CheckinForm({ initial }: { initial: NonNullable<ReturnType<typeof getFlow<unknown, unknown, ProductHit>>>['choice'] }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // The flow's own stack (Feed, or You from your Impressions: lists plan D8).
  const mount = useSessionTab();

  // One client id per flow (this screen stays mounted under the rate stage).
  const [occurrenceId] = useState(() => newClientId());
  const [picker, setPicker] = useState<PickerState>({ status: 'none' });
  const [frozen, setFrozen] = useState<{ label: BottleLabel; isNew: boolean } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // These details opened AGAIN (back to the search, a pick): the check-in's
  // draft (the search cleared any older one) seeds every field, so a retry
  // after a post that may have landed never sends them empty (Codex
  // 2026-11-22: "Rate It" overwrote the draft with blank fields and no photo).
  const [seed] = useState(() => getCheckinDraft(mount.tab));
  const [photo, setPhoto] = useState<PhotoState>(seed?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [process, setProcess] = useState(seed?.vinification ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [purchaseUrl, setPurchaseUrl] = useState(seed?.purchaseUrl ?? '');
  const [venue, setVenue] = useState(seed?.venue ?? '');
  const [city, setCity] = useState(seed?.city ?? '');
  const [moreOpen, setMoreOpen] = useState(!!(seed?.vinification || seed?.description || seed?.purchaseUrl));
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const cityRef = useRef<TextInputInstance>(null);
  const purchaseRef = useRef<TextInputInstance>(null);

  // Back from the rate stage after a post that MAY have landed: the choice is
  // frozen (ADR-0009), so the retry sends the same wine, also when these
  // details were opened again from the search (the draft outlives them).
  useFocusEffect(useCallback(() => {
    const d = getCheckinDraft(mount.tab);
    if (d?.frozen) setFrozen({ label: d.choice.label, isNew: d.choice.kind === 'create' });
  }, [mount.tab]));

  const onPickPhoto = async () => {
    setPhotoError(null);
    const picked = await pickPhoto(MAX_COVER_BYTES);
    if (!picked) return; // cancelled
    if ('failed' in picked) {
      setPhotoError("Couldn't use that photo. Try another.");
      return;
    }
    setPhoto(picked);
  };

  const onRate = () => {
    setError(null);
    setShowErrors(true);
    const prev = getCheckinDraft(mount.tab);
    const choice = prev?.frozen ? prev.choice : picker.status === 'ok' ? picker.choice : null;
    if (!choice) {
      setError(picker.status === 'error' ? picker.error : picker.status === 'pending' ? 'One moment, the years are still loading.' : 'Choose the bottle first.');
      return;
    }
    // Preserve an in-progress rating from a prior visit to stage 2 (the rate
    // screen wrote it back on unmount) — a back-swipe to tweak a detail must
    // not wipe the score already set.
    // (and the rate stage's Hide from Feed once shown: Moment Defaults).
    setCheckinDraft(mount.tab, nextCheckinDraft(prev, { choice, photo, vinification: process, description, purchaseUrl, venue, city }, occurrenceId));
    router.push(checkinHref(mount, 'rate'));
  };

  return (
    // BottomSheetModalProvider in-screen so the picker's Country sheet gets a
    // sized host across the Stack boundary (same as add.tsx / create.tsx).
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Check In" />
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* The bottle first (ADR-0009): the pick these details opened with. */}
        <BottlePicker scope={null} initial={initial} frozen={frozen} showErrors={showErrors} onChange={setPicker} />

        <PhotoPicker photo={photo} onPick={onPickPhoto} onClear={() => { setPhoto(null); setPhotoError(null); }} />
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}

        {/* Where — the VENUE (where you had it), always visible, not folded
            (Simon: "more prominent" — the place is half the memory of a
            check-in). Distinct from the wine's ORIGIN (the catalogue's). Feed
            renders it as "venue · city". */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
          <View style={{ flex: 1.4 }}>
            <TextField label="Where You Had It" placeholder="Bar, restaurant, home…" value={venue} onChangeText={setVenue} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cityRef.current?.focus()} />
          </View>
          <View style={{ flex: 1 }}>
            <TextField ref={cityRef} label="City" placeholder="City" value={city} onChangeText={setCity} returnKeyType="done" />
          </View>
        </View>

        {/* .disclosure Add More Details: the bottle's own fields (process ·
            description · purchase link); its origin and grapes are the
            catalogue wine's (ADR-0009). The fold is back (ruled 2026-11-22). */}
        <Disclosure
          label="Add More Details"
          open={moreOpen}
          onToggle={() => setMoreOpen((o) => !o)}
          onExpanded={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          <TextField label="Process" placeholder="Vinification, roast, ferment…" value={process} onChangeText={setProcess} growLines={3} />
          <NotesField label="Description" placeholder="Anything to remember about it…" value={description} onChange={setDescription} />
          <TextField
            ref={purchaseRef}
            label="Purchase Link"
            placeholder="Where to buy it"
            value={purchaseUrl}
            onChangeText={setPurchaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            keyboardType="url"
          />
        </Disclosure>

      </ScrollView>

      {/* Sticky "Rate It" — the plain opaque bar (02b·add's ruling). Stage 1
          only validates and hands off; nothing is posted from here. */}
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
        <Button title="Rate It" onPress={onRate} bar block />
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}

// .at-photo — the 02b·add dashed add affordance; a picked image previews in
// place with a glass × to clear. (Still a copy — the <CoverPickerField>
// extraction in apps/mobile/CLAUDE.md stays pending; this matches the add.tsx
// canonical version minus the edit-mode 'existing' state.)
function PhotoPicker({
  photo, onPick, onClear,
}: {
  photo: PhotoState;
  onPick: () => void;
  onClear: () => void;
}) {
  const { theme } = useTheme();
  const [fullscreen, setFullscreen] = useState(false);
  if (photo) {
    return (
      <View style={{ height: 150, borderRadius: radius.md, overflow: 'hidden', marginBottom: 16 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
          <Image source={{ uri: photo.previewUri }} alt="" style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove Photo"
          onPress={onClear}
          style={{
            position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14,
            backgroundColor: GLASS_FILL, alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="x" size={14} color="#fff" />
        </Pressable>
        <FullscreenImage uri={photo.previewUri} visible={fullscreen} label="Wine Photo" onClose={() => setFullscreen(false)} />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPick}
      style={({ pressed }) => ({
        height: 104, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed',
        borderColor: theme.rule, backgroundColor: theme.surfaceSunk,
        alignItems: 'center', justifyContent: 'center', gap: 2, marginBottom: 16,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name="cam" size={24} color={theme.inkSoft} />
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 4 }}>Add Photo</VText>
      {/* No line under it (ruled 2026-11-22: not "Optional.", nothing wine-only,
          and not "moment": a check-in is an impression, not a moment). */}
    </Pressable>
  );
}
