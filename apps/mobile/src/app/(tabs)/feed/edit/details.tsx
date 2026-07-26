import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { countryName, filterVintageInput, normalizeVintageText } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { CountrySheet, Disclosure, MAX_COVER_BYTES, NotesField, OptionSheet, pickPhoto, SelectField } from '@/components/moments/momentForm';
import { type WineTypeCode } from '@/lib/api/sessions';
import { getCheckinEditMeta, setCheckinEditMeta } from '@/lib/checkinEdit';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { WINE_TYPES } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

// Standalone check-in EDIT, the impression-details sub-screen (Simon,
// 2026-07-17: the square on the edit screen taps through here). The create
// stage-1 field anatomy (check-in/index.tsx), seeded from the shared edit
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

  const [photo, setPhoto] = useState<PhotoEdit>(meta?.photo);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [name, setName] = useState(meta?.name ?? '');
  const [vintage, setVintage] = useState(meta?.vintage ?? '');
  const [producer, setProducer] = useState(meta?.producer ?? '');
  const [type, setType] = useState<WineTypeCode | null>(meta?.type ?? null);
  const [grape, setGrape] = useState(meta?.grape ?? '');
  const [region, setRegion] = useState(meta?.wineRegion ?? '');
  const [country, setCountry] = useState(meta?.wineCountry ?? '');
  const [process, setProcess] = useState(meta?.vinification ?? '');
  const [description, setDescription] = useState(meta?.description ?? '');
  const [purchaseUrl, setPurchaseUrl] = useState(meta?.purchaseUrl ?? '');
  const [venue, setVenue] = useState(meta?.venue ?? '');
  const [city, setCity] = useState(meta?.city ?? '');
  // Open the fold when any of its fields carries a value — an edit must not
  // hide filled fields behind a closed disclosure.
  const [moreOpen, setMoreOpen] = useState(
    !!(meta?.wineRegion || meta?.wineCountry || meta?.vinification || meta?.description || meta?.purchaseUrl),
  );
  const [typeOpen, setTypeOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const vintageRef = useRef<TextInput>(null);
  const varietyRef = useRef<TextInput>(null);
  const venueRef = useRef<TextInput>(null);
  const cityRef = useRef<TextInput>(null);
  const processRef = useRef<TextInput>(null);
  const purchaseRef = useRef<TextInput>(null);

  // Cold deep link / stale store — nothing to edit; bounce to the feed.
  useEffect(() => {
    if (!meta) router.replace('/feed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!meta) return <View style={{ flex: 1 }} />;

  const onPickPhoto = async () => {
    setPhotoError(null);
    const picked = await pickPhoto(MAX_COVER_BYTES);
    if (!picked) return;
    if ('failed' in picked) {
      setPhotoError("Couldn't use that photo — try another.");
      return;
    }
    setPhoto(picked);
  };

  const onDone = () => {
    setError(null);
    if (!name.trim()) { setError('Give it a name.'); return; }
    setCheckinEditMeta({
      ...meta,
      // Canonicalize here (the store feeds the PATCH directly) so a half-typed
      // NV-token prefix never reaches the Char(4) column.
      name, vintage: normalizeVintageText(vintage), producer, type, grape,
      wineRegion: region, wineCountry: country,
      vinification: process, description, purchaseUrl,
      venue, city,
      photo,
    });
    router.back();
  };

  const typeLabel = type ? WINE_TYPES.find((t) => t.code === type)?.label ?? '' : '';
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
            <VText variant="caption" color="inkSoft">optional — capture the moment</VText>
          </Pressable>
        )}
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
          <View style={{ flex: 1 }}>
            <TextField label="Name" placeholder="What did you have?" value={name} onChangeText={setName} autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => vintageRef.current?.focus()} />
          </View>
          <View style={{ width: 76 }}>
            {/* Year OR "NV" — the digit strip here was DESTRUCTIVE, not just
                restrictive: on an existing NV check-in, the first text change
                blanked the vintage (the strip removed every character), and
                saving then PATCHed the empty value. */}
            <TextField
              ref={vintageRef}
              label="Vintage"
              placeholder="Year / NV"
              value={vintage}
              onChangeText={(t) => setVintage(filterVintageInput(t))}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </View>
        </View>

        <View style={{ marginBottom: 14 }}>
          <TextField label="Producer" placeholder="Maker or winery" value={producer} onChangeText={setProducer} autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => varietyRef.current?.focus()} />
        </View>

        <View style={{ gap: 7, marginBottom: 14 }}>
          <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Type</VText>
          <SelectField
            value={typeLabel}
            placeholder="Choose a type"
            onPress={() => setTypeOpen(true)}
            accessibilityLabel={`Type${typeLabel ? `: ${typeLabel}` : ''}`}
          />
        </View>

        <View style={{ marginBottom: 14 }}>
          <TextField ref={varietyRef} label="Variety" placeholder="Grape, bean, hops…" value={grape} onChangeText={setGrape} autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => venueRef.current?.focus()} />
        </View>

        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
          <View style={{ flex: 1.4 }}>
            <TextField ref={venueRef} label="Where You Had It" placeholder="Bar, restaurant, home…" value={venue} onChangeText={setVenue} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cityRef.current?.focus()} />
          </View>
          <View style={{ flex: 1 }}>
            <TextField ref={cityRef} label="City" placeholder="City" value={city} onChangeText={setCity} returnKeyType="done" />
          </View>
        </View>

        <Disclosure
          label="Add More Details"
          open={moreOpen}
          onToggle={() => setMoreOpen((o) => !o)}
          onExpanded={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <TextField label="Region" placeholder="Where it is from" value={region} onChangeText={setRegion} autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => processRef.current?.focus()} />
            </View>
            <View style={{ flex: 1, gap: 7 }}>
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Country</VText>
              <SelectField
                value={countryName(country) || ''}
                placeholder="Country"
                onPress={() => setCountryOpen(true)}
                accessibilityLabel={`Country${country ? `: ${countryName(country)}` : ''}`}
              />
            </View>
          </View>
          <TextField ref={processRef} label="Process" placeholder="Vinification, roast, ferment…" value={process} onChangeText={setProcess} growLines={3} />
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

      <OptionSheet open={typeOpen} title="Type" options={WINE_TYPES} selected={type} onSelect={(t) => { setType(t); setTypeOpen(false); }} onClose={() => setTypeOpen(false)} />
      <CountrySheet open={countryOpen} selected={country} onSelect={(c) => { setCountry(c); setCountryOpen(false); }} onClose={() => setCountryOpen(false)} />
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
