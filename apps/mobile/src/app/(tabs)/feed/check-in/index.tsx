import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { countryName, filterVintageInput } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { CountrySheet, Disclosure, MAX_COVER_BYTES, NotesField, OptionSheet, pickPhoto, SelectField } from '@/components/moments/momentForm';
import { type WineTypeCode } from '@/lib/api/sessions';
import { clearCheckinDraft, getCheckinDraft, setCheckinDraft } from '@/lib/checkinDraft';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { WINE_TYPES } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

// Standalone check-in create, STAGE 1 of 2: the details (Simon's two-stage
// ruling, 2026-07-08 — "first you add the details, then you rate it and check
// it in"). This screen is the full 02b·add field set (identity + the
// Add-More-Details metadata fold) plus the venue fold; "Rate It" hands off to
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
// Photo cap: MAX_COVER_BYTES, NOT the session wine cap — /api/checkins uploads
// through the s3 pipeline (~2MB decoded), not session.ts sanitizeImage (1.5MB).
// Anything larger is silently dropped server-side, so the client must fit
// under the real cap (see CreateCheckinBody's note in lib/api/feed.ts).

type PhotoState = { dataUrl: string; previewUri: string } | null;

export default function CheckinDetails() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [photo, setPhoto] = useState<PhotoState>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [vintage, setVintage] = useState('');
  const [producer, setProducer] = useState('');
  const [type, setType] = useState<WineTypeCode | null>(null);
  const [grape, setGrape] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState(''); // WINE origin, ISO-2, '' = unset
  const [process, setProcess] = useState('');
  const [description, setDescription] = useState('');
  const [purchaseUrl, setPurchaseUrl] = useState('');
  const [venue, setVenue] = useState('');
  const [city, setCity] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Return-key chaining like 02b·add, per sub-chain (never across a fold):
  // Name→Vintage (a focus target only — number-pad has no return key),
  // Producer→Variety→Venue→City, Region→Process→Purchase link. Type/Country
  // (dropdowns) and Description (multiline) are skipped.
  const vintageRef = useRef<TextInput>(null);
  const varietyRef = useRef<TextInput>(null);
  const venueRef = useRef<TextInput>(null);
  const cityRef = useRef<TextInput>(null);
  const processRef = useRef<TextInput>(null);
  const purchaseRef = useRef<TextInput>(null);

  // A mount of this screen IS a new flow (it stays mounted beneath stage 2,
  // so a back-swipe from the rate stage does NOT re-run this). Clear any
  // leftover draft from an ABANDONED earlier flow — without this, backing out
  // at stage 2 leaves the old rating in the store and onRate's preserve-prev
  // read would silently inherit it into the next check-in (codex P1).
  useEffect(() => {
    clearCheckinDraft();
  }, []);

  const onPickPhoto = async () => {
    setPhotoError(null);
    const picked = await pickPhoto(MAX_COVER_BYTES);
    if (!picked) return; // cancelled
    if ('failed' in picked) {
      setPhotoError("Couldn't use that photo — try another.");
      return;
    }
    setPhoto(picked);
  };

  const onRate = () => {
    setError(null);
    if (!name.trim()) { setError('Give it a name.'); return; }
    // Preserve an in-progress rating from a prior visit to stage 2 (the rate
    // screen wrote it back on unmount) — a back-swipe to tweak a detail must
    // not wipe the score already set.
    const prev = getCheckinDraft();
    setCheckinDraft({
      photo,
      name, vintage, producer, type, grape,
      wineRegion: region, wineCountry: country,
      vinification: process, description, purchaseUrl,
      venue, city,
      score: prev?.score ?? 0,
      flavors: prev?.flavors ?? {},
      aromas: prev?.aromas ?? [],
      notes: prev?.notes ?? '',
    });
    router.push('/feed/check-in/rate');
  };

  const typeLabel = type ? WINE_TYPES.find((t) => t.code === type)?.label ?? '' : '';

  return (
    // BottomSheetModalProvider in-screen so the Type/Country brand sheets get
    // a sized host across the Stack boundary (same as add.tsx / create.tsx).
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
        <PhotoPicker photo={photo} onPick={onPickPhoto} onClear={() => { setPhoto(null); setPhotoError(null); }} />
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}

        {/* .trow2-name — Name (wide) + Vintage (narrow 76), the 02b·add row. */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
          <View style={{ flex: 1 }}>
            <TextField label="Name" placeholder="What did you have?" value={name} onChangeText={setName} autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => vintageRef.current?.focus()} />
          </View>
          <View style={{ width: 76 }}>
            {/* Year OR "NV" — see the add-impression screen's note: a
                number-pad keyboard made NV untypeable. */}
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

        {/* Type — optional here (unlike 02b·add): the server coerces unknown/
            absent to null and a typeless check-in renders fine. It drives the
            structure axes on the rate stage when set. */}
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

        {/* Where — the VENUE (where you had it), always visible, not folded
            (Simon: "more prominent" — the place is half the memory of a
            check-in). Distinct from the wine's ORIGIN in the fold below. Feed
            renders it as "venue · city". */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
          <View style={{ flex: 1.4 }}>
            <TextField ref={venueRef} label="Where You Had It" placeholder="Bar, restaurant, home…" value={venue} onChangeText={setVenue} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cityRef.current?.focus()} />
          </View>
          <View style={{ flex: 1 }}>
            {/* Last always-visible field — Region lives behind the disclosure
                fold, so we stop here ("done") rather than focus an unmounted
                field. */}
            <TextField ref={cityRef} label="City" placeholder="City" value={city} onChangeText={setCity} returnKeyType="done" />
          </View>
        </View>

        {/* .disclosure Add More Details — the 02b·add metadata fold (region ·
            country · process · description · purchase link), now accepted by
            POST /api/checkins onto the minted wine row (the reason this flow
            went two-stage: the single screen couldn't carry these). */}
        <Disclosure
          label="Add More Details"
          open={moreOpen}
          onToggle={() => setMoreOpen((o) => !o)}
          onExpanded={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {/* .trow2-even — Region + Country (the WINE's origin, distinct from
              the venue below). */}
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
          {/* Process → Purchase link skips the multiline Description (return =
              newline there, not a chain link). */}
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

      <OptionSheet open={typeOpen} title="Type" options={WINE_TYPES} selected={type} onSelect={(t) => { setType(t); setTypeOpen(false); }} onClose={() => setTypeOpen(false)} />
      <CountrySheet open={countryOpen} selected={country} onSelect={(c) => { setCountry(c); setCountryOpen(false); }} onClose={() => setCountryOpen(false)} />
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
      {/* Warmer than add.tsx's "a label or pour" — Simon: the caption should
          feel connected to the moment, not like a spec of accepted subjects. */}
      <VText variant="caption" color="inkSoft">optional — capture the moment</VText>
    </Pressable>
  );
}
