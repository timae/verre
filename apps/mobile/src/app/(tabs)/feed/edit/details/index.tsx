import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, View, type TextInputInstance, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { normalizePublicUserId } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { Disclosure, MAX_COVER_BYTES, NotesField, pickPhoto } from '@/components/moments/momentForm';
import { BottlePicker, type PickerState } from '@/components/catalog/BottlePicker';
import { authClient } from '@/lib/authClient';
import { getCheckinEditMeta, setCheckinEditMeta } from '@/lib/checkinEdit';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { feedListHref, useSessionTab } from '@/lib/sessionStack';
import { radius, useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';

// Standalone check-in EDIT, the impression-details sub-screen (Simon,
// 2026-07-17: the square on the edit screen taps through here). The create
// stage-1 anatomy (check-in/index.tsx: the bottle first, picked from the
// catalogue, ADR-0009; Change re-links it), seeded from the shared edit
// store and written back on Done — nothing is posted from here; the edit
// screen's Save owns the PATCH. Photo edit adds the `existing` mode the
// create picker doesn't need: unchanged (remote preview) / replaced (fresh
// pick) / removed (null → the PATCH sends imageData: null).

type PhotoEdit = { dataUrl: string; previewUri: string } | null | undefined;

export default function EditCheckinDetails() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const meta = getCheckinEditMeta();
  const { user } = useLocalSearchParams<{ user?: string }>();
  const listUserId = normalizePublicUserId(user);
  const tab = useSessionTab();
  const meId = useMeId();

  const [photo, setPhoto] = useState<PhotoEdit>(meta?.photo);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState>({ status: 'unchanged' });
  const [showErrors, setShowErrors] = useState(false);
  const [process, setProcess] = useState(meta?.vinification ?? '');
  const [description, setDescription] = useState(meta?.description ?? '');
  const [purchaseUrl, setPurchaseUrl] = useState(meta?.purchaseUrl ?? '');
  const [venue, setVenue] = useState(meta?.venue ?? '');
  const [city, setCity] = useState(meta?.city ?? '');
  // Open the fold when any of its fields carries a value — an edit must not
  // hide filled fields behind a closed disclosure.
  const [moreOpen, setMoreOpen] = useState(
    !!(meta?.vinification || meta?.description || meta?.purchaseUrl),
  );
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const cityRef = useRef<TextInputInstance>(null);
  const purchaseRef = useRef<TextInputInstance>(null);

  // Cold deep link / stale store — nothing to edit; bounce to the list it
  // came from (this screen is mounted under Feed AND You).
  useEffect(() => {
    if (!meta) {
      // On an opened post's stack a replace would land on the outer stack.
      if (tab.post != null && router.canGoBack()) router.back();
      else router.replace(feedListHref(tab, listUserId, meId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!meta) return <View style={{ flex: 1 }} />;

  const onPickPhoto = async () => {
    setPhotoError(null);
    const picked = await pickPhoto(MAX_COVER_BYTES);
    if (!picked) return;
    if ('failed' in picked) {
      setPhotoError("Couldn't use that photo. Try another.");
      return;
    }
    setPhoto(picked);
  };

  const onDone = () => {
    setError(null);
    setShowErrors(true);
    if (picker.status !== 'unchanged' && picker.status !== 'ok') {
      setError(picker.status === 'error' ? picker.error : picker.status === 'pending' ? 'One moment, the years are still loading.' : 'Choose the bottle, or keep it.');
      return;
    }
    setCheckinEditMeta({
      ...meta,
      ...(picker.status === 'ok' ? { choice: picker.choice } : {}),
      vinification: process, description, purchaseUrl,
      venue, city,
      photo,
    });
    router.back();
  };

  // Photo display state: fresh pick > unchanged remote > removed/none.
  const previewUri = photo === null ? null : photo?.previewUri ?? meta.existingImageUrl;

  return (
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Edit Impression" />
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
        {/* The bottle first (ADR-0009): its wine, or Change to re-link it. */}
        <BottlePicker scope={null} inDetails current={meta.choice?.label ?? meta.label} showErrors={showErrors} onChange={setPicker} />

        {previewUri ? (
          <View style={{ height: 150, borderRadius: radius.md, overflow: 'hidden', marginBottom: 16 }}>
            <PhotoPreview uri={previewUri} onClear={() => { setPhoto(null); setPhotoError(null); }} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={onPickPhoto}
            style={({ pressed }) => ({
              height: 104, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed',
              borderColor: theme.rule, backgroundColor: theme.surfaceSunk,
              alignItems: 'center', justifyContent: 'center', gap: 2, marginBottom: 16,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="cam" size={24} color={theme.inkSoft} />
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 4 }}>Add Photo</VText>
            <VText variant="caption" color="inkSoft">Optional. Capture the moment.</VText>
          </Pressable>
        )}
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
          <View style={{ flex: 1.4 }}>
            <TextField label="Where You Had It" placeholder="Bar, restaurant, home…" value={venue} onChangeText={setVenue} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cityRef.current?.focus()} />
          </View>
          <View style={{ flex: 1 }}>
            <TextField ref={cityRef} label="City" placeholder="City" value={city} onChangeText={setCity} returnKeyType="done" />
          </View>
        </View>

        {/* .disclosure Add More Details: the bottle's own fields (the fold is
            back, ruled 2026-11-22; open when one of them is set). */}
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
        <Button title="Done" onPress={onDone} bar block />
      </View>

    </View>
    </BottomSheetModalProvider>
  );
}

// The picked/remote preview with the glass × (the create picker's preview
// half, plus fullscreen open) — clearing sets photo=null (removal).
function PhotoPreview({ uri, onClear }: { uri: string; onClear: () => void }) {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Open photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
        <Image source={{ uri }} alt="" style={{ width: '100%', height: '100%' }} resizeMode="cover" />
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
      <FullscreenImage uri={uri} visible={fullscreen} label="Wine Photo" onClose={() => setFullscreen(false)} />
    </>
  );
}
