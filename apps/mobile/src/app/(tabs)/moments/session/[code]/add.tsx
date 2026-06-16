import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { BottomSheetModalProvider, BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { COUNTRIES, countryName } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { MAX_WINE_IMAGE_BYTES, NotesField, pickCover } from '@/components/moments/momentForm';
import { ApiError, addWine, getSessionState, type WineTypeCode } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { FOOT_CLEARANCE, GLASS_FILL, GUTTER } from '@/lib/layout';
import { elevation, radius, useTheme } from '@/theme';

// The 5 wine types the backend accepts (lib/session.ts). FLAGGED DEVIATION
// from the mock's 7-option dropdown (Orange/Dessert/Fortified have no backend
// home): these match the web AddWineModal exactly. Labels are the web's
// ("Bubbles" for spark, "Non-alc" for nonalc), code is what the server stores.
const WINE_TYPES: Array<{ code: WineTypeCode; label: string }> = [
  { code: 'red', label: 'Red' },
  { code: 'white', label: 'White' },
  { code: 'spark', label: 'Sparkling' },
  { code: 'rose', label: 'Rosé' },
  { code: 'nonalc', label: 'Non-alc' },
];

// 02b·add add-impression — a pushed full-screen form (FLAGGED DEVIATION from
// the mock's bottom sheet, same call as 02f settings: a sticky "Add to line-up"
// bar sticks cleanly via the create.tsx .vfoot pattern, no gorhom footer
// gymnastics). Fields map design→server: Variety→grape, Process→vinification.
// Reaches the existing POST /api/session/:code/wines (host/cohost/provider).
export default function AddImpression() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const router = useRouter();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Read the SAME cached query the parent line-up polls (same key) — deduped by
  // TanStack, so this gets the live wines + meta for free without a second
  // interval. We only need the line-up length (position range) and the host
  // check (whether to offer the position picker). The form mounts immediately;
  // add-rights are enforced by the entry control + the server, so an unresolved
  // cache just means "append at end, no picker yet".
  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
  });
  const meta = state.data?.meta ?? null;
  const wineCount = state.data?.wines?.length ?? 0;

  // Normally this screen is pushed from the line-up (which already POSTed
  // /visit), so the cache is warm and this query just serves it. But the route
  // is URL-addressable: a cold deep-link has no prior /visit, so /state 401s
  // (`invalid`). Rather than let the user fill out a form that will fail on
  // submit, bounce to the line-up — it owns the visit + rejoin flow (same idiom
  // as useSettingsSession). not-found/removed bounce there too.
  const fatal =
    state.error instanceof ApiError &&
    (state.error.kind === 'invalid' || state.error.kind === 'removed' || state.error.kind === 'not-found');
  useEffect(() => {
    if (fatal) router.replace({ pathname: '/(tabs)/moments/session/[code]', params: { code } });
  }, [fatal, code, router]);

  // Position is host-only server-side (providers always append). Offer the
  // picker only to a host/cohost — same check as the line-up's isHostViewer —
  // so a provider isn't shown a control the server ignores.
  const canPosition =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));

  return <AddForm code={code} wineCount={wineCount} canPosition={canPosition} />;
}

function AddForm({ code, wineCount, canPosition }: { code: string; wineCount: number; canPosition: boolean }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [photo, setPhoto] = useState<{ dataUrl: string; previewUri: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [vintage, setVintage] = useState('');
  const [producer, setProducer] = useState('');
  const [type, setType] = useState<WineTypeCode | null>(null);
  const [grape, setGrape] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState(''); // ISO-2 code, '' = unset
  const [process, setProcess] = useState('');
  const [description, setDescription] = useState('');
  const [purchaseUrl, setPurchaseUrl] = useState('');
  // null = "append" (follow the live count) — the user hasn't chosen a slot.
  // Kept null rather than seeded to wineCount+1 so a count that resolves AFTER
  // mount (cold deep-link before the parent poll lands) doesn't leave a stale
  // default: the pill + picker read the live maxPosition until the user picks.
  const [position, setPosition] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [posOpen, setPosOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxPosition = wineCount + 1; // a new wine can land anywhere 1..count+1

  const onPickPhoto = async () => {
    setPhotoError(null);
    const picked = await pickCover(MAX_WINE_IMAGE_BYTES);
    if (!picked) return; // cancelled
    if ('failed' in picked) {
      setPhotoError("Couldn't use that photo — try another.");
      return;
    }
    setPhoto(picked);
  };

  const onAdd = async () => {
    setError(null);
    if (!name.trim()) { setError('Give the impression a name.'); return; }
    if (!type) { setError('Pick a type.'); return; }
    setSaving(true);
    try {
      await addWine(code, {
        name: name.trim(),
        type,
        ...(producer.trim() ? { producer: producer.trim() } : {}),
        ...(vintage.trim() ? { vintage: vintage.trim() } : {}),
        ...(grape.trim() ? { grape: grape.trim() } : {}),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(country ? { country } : {}),
        ...(process.trim() ? { vinification: process.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(purchaseUrl.trim() ? { purchaseUrl: purchaseUrl.trim() } : {}),
        ...(photo ? { image: photo.dataUrl } : {}),
        // Send a position only when the host explicitly chose a non-append slot.
        // null (untouched) or == maxPosition both mean "append", which the
        // server does by default — so we omit it (host-only server-side anyway).
        ...(canPosition && position !== null && position !== maxPosition ? { position } : {}),
      });
      // Invalidate the line-up's cached state (keyed by code + myIdentityId, so
      // a code-prefixed invalidate covers it) — the parent poll refetches and
      // the new wine appears. router.back() returns to the line-up.
      queryClient.invalidateQueries({ queryKey: ['session-state', code] });
      router.back();
    } catch (e) {
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : "Couldn't add it. Check your connection and try again.");
    }
  };

  const typeLabel = type ? WINE_TYPES.find((t) => t.code === type)?.label ?? '' : '';

  return (
    // BottomSheetModalProvider in-screen so the Type/Country brand sheets get a
    // sized host across the Stack boundary (same as create.tsx / index.tsx).
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      {/* .at-head — title + the .at-poswrap position picker (pill that toggles
          an anchored popover beneath it). zIndex so the open popover paints over
          the form below. */}
      <View style={{ paddingHorizontal: GUTTER, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', zIndex: 20 }}>
        <View style={{ flex: 1 }}>
          <VBar title="Add impression" />
        </View>
        {canPosition && wineCount > 0 ? (
          <PositionPicker
            value={position ?? maxPosition}
            max={maxPosition}
            open={posOpen}
            onOpenChange={setPosOpen}
            onChange={setPosition}
          />
        ) : null}
      </View>
      {/* Outside-tap catcher for the anchored popover — a transparent full-screen
          layer under the popover (which lives in the header above, zIndex 20) but
          over everything else. Tapping anywhere else closes it. */}
      {posOpen ? (
        <Pressable
          accessibilityLabel="Close position picker"
          onPress={() => setPosOpen(false)}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 15 }}
        />
      ) : null}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <PhotoPicker photo={photo} onPick={onPickPhoto} onClear={() => { setPhoto(null); setPhotoError(null); }} />
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}

        {/* .trow2-name — Name (wide) + Vintage (narrow 76). */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
          <View style={{ flex: 1 }}>
            <TextField label="Name" placeholder="e.g. Oslavje" value={name} onChangeText={setName} autoCorrect={false} />
          </View>
          <View style={{ width: 76 }}>
            <TextField
              label="Vintage"
              placeholder="Year"
              value={vintage}
              onChangeText={(t) => setVintage(t.replace(/\D/g, '').slice(0, 4))}
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>
        </View>

        <View style={{ marginBottom: 14 }}>
          <TextField label="Producer" placeholder="Maker or winery" value={producer} onChangeText={setProducer} autoCorrect={false} />
        </View>

        {/* Type — required. Native-chrome dropdown → brand picker sheet (the
            create.tsx CategorySheet pattern). */}
        <View style={{ gap: 7, marginBottom: 14 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>Type</VText>
          <SelectField
            value={typeLabel}
            placeholder="Choose a type"
            onPress={() => setTypeOpen(true)}
            accessibilityLabel={`Type${typeLabel ? `: ${typeLabel}` : ''}`}
          />
        </View>

        <View style={{ marginBottom: 4 }}>
          <TextField label="Variety" placeholder="Grape, bean, hops…" value={grape} onChangeText={setGrape} autoCorrect={false} />
        </View>

        {/* .disclosure Add more details */}
        <Pressable
          onPress={() => setMoreOpen((o) => !o)}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            borderTopWidth: 1, borderTopColor: theme.rule,
            marginTop: 18, paddingTop: 16, paddingBottom: 4,
          }}
        >
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>Add more details</VText>
          <View style={{ transform: [{ rotate: moreOpen ? '180deg' : '0deg' }] }}>
            <Icon name="chevron-down" size={18} color={theme.inkSoft} />
          </View>
        </Pressable>
        {moreOpen ? (
          <View style={{ gap: 14, marginTop: 14 }}>
            {/* .trow2-even — Region + Country. */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <TextField label="Region" placeholder="Where it is from" value={region} onChangeText={setRegion} autoCorrect={false} />
              </View>
              <View style={{ flex: 1, gap: 7 }}>
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>Country</VText>
                <SelectField
                  value={countryName(country) || ''}
                  placeholder="Country"
                  onPress={() => setCountryOpen(true)}
                  accessibilityLabel={`Country${country ? `: ${countryName(country)}` : ''}`}
                />
              </View>
            </View>
            <TextField label="Process" placeholder="Vinification, roast, ferment…" value={process} onChangeText={setProcess} />
            <NotesField label="Description" placeholder="Anything to remember about it…" value={description} onChange={setDescription} />
            <TextField
              label="Purchase link"
              placeholder="Where to buy it"
              value={purchaseUrl}
              onChangeText={setPurchaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        ) : null}
      </ScrollView>

      {/* Sticky "Add to line-up" — SOLID theme.bg fill, no gradient fade. The
          create.tsx .vfoot uses a transparent→bg gradient, but we deliberately
          don't here (Simon's call): a plain opaque bar, matching SettingsFooter.
          The error banner lives HERE (above the button), not in the scroll body:
          a validation error (no name / no type) must always be visible, but the
          body scrolls (small screen / "Add more details" expanded) and an error
          at its end would land below the fold. (Web AddWineModal does the same.) */}
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
        <Button title="Add to line-up" loadingTitle="Adding…" loading={saving} onPress={onAdd} bar block />
      </View>

      <TypeSheet open={typeOpen} selected={type} onSelect={(t) => { setType(t); setTypeOpen(false); }} onClose={() => setTypeOpen(false)} />
      <CountrySheet open={countryOpen} selected={country} onSelect={(c) => { setCountry(c); setCountryOpen(false); }} onClose={() => setCountryOpen(false)} />
    </View>
    </BottomSheetModalProvider>
  );
}

// .at-photo — dashed add affordance ("Add photo / or scan the label"); a picked
// image previews in place (.at-photo-set, 150px) with a glass × to clear.
// (Scan-label is web-only AI — the subtitle keeps the design copy but there's
// no scan action here; flagged deviation.)
function PhotoPicker({
  photo, onPick, onClear,
}: {
  photo: { dataUrl: string; previewUri: string } | null;
  onPick: () => void;
  onClear: () => void;
}) {
  const { theme } = useTheme();
  if (photo) {
    return (
      <View style={{ height: 150, borderRadius: radius.md, overflow: 'hidden', marginBottom: 16 }}>
        <Image source={{ uri: photo.previewUri }} alt="" style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove photo"
          onPress={onClear}
          style={{
            position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14,
            backgroundColor: GLASS_FILL, alignItems: 'center', justifyContent: 'center',
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
        height: 104, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed',
        borderColor: theme.rule, backgroundColor: theme.surfaceSunk,
        alignItems: 'center', justifyContent: 'center', gap: 2, marginBottom: 16,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name="cam" size={24} color={theme.inkSoft} />
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 18, marginTop: 4 }}>Add photo</VText>
      <VText variant="caption" color="inkSoft">optional — a label or pour</VText>
    </Pressable>
  );
}

// .field + .select-wrap — a tappable field box that reads like a dropdown
// (value or placeholder + a trailing chevron). Native-chrome dropdown rendered
// as a brand trigger; the actual choosing happens in a sheet.
function SelectField({
  value, placeholder, onPress, accessibilityLabel,
}: {
  value: string;
  placeholder: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 14, backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
        borderWidth: 1, borderColor: theme.rule, borderRadius: radius.sm,
      })}
    >
      <VText variant="body" color={value ? 'ink' : 'inkFaint'} numberOfLines={1} style={{ flex: 1 }}>
        {value || placeholder}
      </VText>
      <Icon name="chevron-down" size={18} color={theme.inkSoft} />
    </Pressable>
  );
}

// Type picker — brand bottom sheet (create.tsx CategorySheet shell). All 5 are
// choosable; the selected one carries a check.
function TypeSheet({
  open, selected, onSelect, onClose,
}: {
  open: boolean;
  selected: WineTypeCode | null;
  onSelect: (t: WineTypeCode) => void;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={{ paddingTop: 8, paddingBottom: insets.bottom + 8 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
            Type
          </VText>
        </View>
        {WINE_TYPES.map((t) => {
          const on = t.code === selected;
          return (
            <Pressable
              key={t.code}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onSelect(t.code)}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 20, paddingVertical: 14,
                backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
              })}
            >
              <VText variant="body">{t.label}</VText>
              {on ? <Icon name="check" size={18} color={theme.accent} /> : null}
            </Pressable>
          );
        })}
      </BottomSheetView>
    </Sheet>
  );
}

// Country picker — brand sheet with a type-to-filter field, reusing the
// canonical @verre/core COUNTRIES list (web↔native shared). A "Clear" row at the
// top removes the selection. Capped height so the long list scrolls.
function CountrySheet({
  open, selected, onSelect, onClose,
}: {
  open: boolean;
  selected: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q));
  }, [query]);
  return (
    <Sheet open={open} onClose={onClose} snapPoints={['75%']} enableDynamicSizing={false}>
      <BottomSheetView style={{ flex: 1, paddingTop: 8, paddingBottom: insets.bottom + 8 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 12 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
            Country
          </VText>
          <TextField placeholder="Type to search…" value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" />
        </View>
        {/* gorhom's own scrollable (NOT a plain RN ScrollView) so the list scroll
            and the sheet's pan gesture cooperate — a plain ScrollView fights the
            sheet (drag scrolls the sheet, not the list). Safe here because the
            sheet is a FIXED 75% snap (enableDynamicSizing off): the scrollable
            gets a definite height from the flex:1 wrapper. (PeopleSheet avoids
            this primitive only because IT uses dynamic sizing, where the
            scrollable measures 0 — a different config.) */}
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 8 }}
          showsVerticalScrollIndicator={false}
        >
          {selected ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear country"
              onPress={() => onSelect('')}
              style={({ pressed }) => ({
                paddingHorizontal: 20, paddingVertical: 13,
                borderBottomWidth: 1, borderBottomColor: theme.ruleSoft,
                backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
              })}
            >
              <VText variant="small" color="inkSoft">× Clear</VText>
            </Pressable>
          ) : null}
          {filtered.length === 0 ? (
            <VText variant="small" color="inkFaint" style={{ paddingHorizontal: 20, paddingVertical: 16, fontStyle: 'italic' }}>
              No matches
            </VText>
          ) : (
            filtered.map((c) => {
              const on = c.code === selected;
              return (
                <Pressable
                  key={c.code}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => onSelect(c.code)}
                  style={({ pressed }) => ({
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    paddingHorizontal: 20, paddingVertical: 13,
                    backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
                  })}
                >
                  <VText variant="body" color={on ? 'accent' : 'ink'}>{c.name}</VText>
                  <VText variant="caption" color="inkFaint">{c.code}</VText>
                </Pressable>
              );
            })
          )}
        </BottomSheetScrollView>
      </BottomSheetView>
    </Sheet>
  );
}

// .at-poswrap — the position-in-line-up picker: a pill (.at-pos-btn) that toggles
// an anchored popover (.at-pospop) beneath it. The popover carries a typed number
// field + a stacked ± spinner, "of N tastes", and the "Drag the number to
// reorder" hint — AND the number is genuinely draggable (vertical pan, ~14px per
// step), per the design's pointer-drag. The popover anchors to the pill via
// absolute positioning inside this wrapper (relative); the parent renders a
// full-screen catcher behind it for outside-tap dismiss.
function posLabel(pos: number, max: number): string {
  if (pos <= 1) return 'First in line-up';
  if (pos >= max) return 'Last in line-up';
  return `#${pos} in line-up`;
}

function PositionPicker({
  value, max, open, onOpenChange, onChange,
}: {
  value: number;
  max: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (n: number) => void;
}) {
  const { theme } = useTheme();
  const [text, setText] = useState(String(value));
  // Re-seed the field on the open edge (value may have changed since last open).
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) setText(String(value));
  wasOpen.current = open;

  const clamp = (n: number) => Math.max(1, Math.min(max, n));
  const commit = (n: number) => {
    const c = clamp(Number.isFinite(n) ? n : value);
    setText(String(c));
    onChange(c);
  };
  const cur = () => clamp(parseInt(text, 10) || value);

  // Vertical drag on the number — up = later in the list (higher #), matching
  // the design (dragStartY - clientY, ~14px per step). gesture-handler Pan;
  // runOnJS so the setState lands on the JS thread. No scroll conflict here (the
  // popover is an anchored overlay, not inside a ScrollView), so a plain
  // vertical Pan is safe — no activeOffset arbitration needed.
  const dragStart = useRef(value);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .onBegin(() => { dragStart.current = cur(); })
    .onUpdate((e) => {
      if (Math.abs(e.translationY) < 4) return;
      commit(dragStart.current + Math.round(-e.translationY / 14));
    });

  return (
    <View style={{ position: 'relative', marginTop: 4 }}>
      {/* .at-pos-btn pill */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Position in line-up: ${posLabel(value, max)} of ${max}`}
        onPress={() => onOpenChange(!open)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 4,
          borderWidth: 1, borderColor: theme.rule, borderRadius: radius.pill,
          paddingVertical: 5, paddingHorizontal: 11,
          backgroundColor: pressed ? theme.surfaceSunk : theme.bg,
        })}
      >
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16 }}>
          {posLabel(value, max)}
        </VText>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon name="chevron-down" size={15} color={theme.inkSoft} />
        </View>
      </Pressable>

      {/* .at-pospop — anchored under the pill, right-aligned. */}
      {open ? (
        <View
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30,
            minWidth: 230, backgroundColor: theme.surface,
            borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, padding: 12,
            // Same dropdown shadow as AnchoredMenu — via the elevation.menu token.
            shadowColor: '#000', shadowOpacity: elevation.menu.ios.shadowOpacity, shadowRadius: elevation.menu.ios.shadowRadius, shadowOffset: { width: 0, height: elevation.menu.ios.shadowOffsetY }, elevation: elevation.menu.android.elevation,
          }}
        >
          {/* .at-popt */}
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }} color="inkSoft">
            Position in line-up
          </VText>
          {/* .at-posrow — number field + ± spinner, then "of N tastes". */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {/* .at-posfield */}
            <View style={{ flexDirection: 'row', alignItems: 'stretch', borderWidth: 1, borderColor: theme.rule, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: theme.bg }}>
              {/* .at-posinput — typed AND drag-to-change (cursor: ns-resize in
                  the mock). The Pan wraps the number so a vertical drag adjusts
                  it; tapping still focuses for typing. */}
              <GestureDetector gesture={pan}>
                <TextInput
                  value={text}
                  onChangeText={(t) => setText(t.replace(/\D/g, ''))}
                  onEndEditing={() => commit(parseInt(text, 10))}
                  keyboardType="number-pad"
                  accessibilityLabel="Position number"
                  style={{
                    width: 52, textAlign: 'center', paddingVertical: 8,
                    fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, color: theme.ink,
                    fontVariant: ['tabular-nums'],
                  }}
                />
              </GestureDetector>
              {/* .at-posspin — stacked ↑ (earlier) / ↓ (later). */}
              <View style={{ borderLeftWidth: 1, borderLeftColor: theme.rule }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Earlier"
                  onPress={() => commit(cur() - 1)}
                  style={({ pressed }) => ({ width: 28, flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.surfaceSunk : theme.surface })}
                >
                  <View style={{ transform: [{ rotate: '180deg' }] }}>
                    <Icon name="chevron-down" size={14} color={theme.inkSoft} />
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Later"
                  onPress={() => commit(cur() + 1)}
                  style={({ pressed }) => ({ width: 28, flex: 1, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: theme.rule, backgroundColor: pressed ? theme.surfaceSunk : theme.surface })}
                >
                  <Icon name="chevron-down" size={14} color={theme.inkSoft} />
                </Pressable>
              </View>
            </View>
            {/* .at-posnow */}
            <VText variant="small" color="inkSoft" style={{ flex: 1 }}>{`of ${max} ${max === 1 ? 'taste' : 'tastes'}`}</VText>
          </View>
          {/* .at-poshint */}
          <VText variant="caption" color="inkFaint" style={{ marginTop: 9 }}>
            Drag the number to reorder
          </VText>
        </View>
      ) : null}
    </View>
  );
}
