import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { fillFlavourZeros, normalizeVintageText, resolveAxes, type AromaSelection } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { RatingSection } from '@/components/scoring/RatingSection';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { ApiError } from '@/lib/api/sessions';
import { createCheckin, FEED_KEY } from '@/lib/api/feed';
import { clearCheckinDraft, getCheckinDraft, setCheckinDraft } from '@/lib/checkinDraft';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { wineTypeLabel } from '@/lib/momentFormat';
import { useTheme } from '@/theme';

// Standalone check-in create, STAGE 2 of 2: the rating moment (Simon's
// two-stage ruling — details first, then "you rate it and check it in").
// Reads the details from lib/checkinDraft.ts (written by stage 1's "Rate It"),
// owns score/structure/notes, and fires the actual POST. The 02e rate blocks
// (ScoreInput + the structure fold) over the check-in identity line.
//
// Rating state writes BACK to the draft on unmount so a back-swipe to stage 1
// (tweak a detail) and a second "Rate It" push restores it. A successful post
// clears the draft first, so that write-back no-ops.

export default function CheckinRate() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Read once at mount — the draft is stable while this screen lives (stage 1
  // only rewrites it on a fresh "Rate It" push, which re-mounts this screen).
  const [draft] = useState(getCheckinDraft);

  const [score, setScore] = useState(draft?.score ?? 0);
  // Prune rated axes to the CURRENT type's set: on a back-and-forth round
  // trip the type may have changed under a saved rating (e.g. spark → red
  // drops bubbles), and the server 400s a non-zero off-style key.
  const [flavors, setFlavors] = useState<Record<string, number>>(() => {
    if (!draft) return {};
    const allowed = new Set(resolveAxes('wine', draft.type).map((a) => a.k));
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(draft.flavors)) if (allowed.has(k)) next[k] = v;
    return next;
  });
  // Draft aromas are already canonical (AromaInput gates every mutation),
  // so unlike the impression screen's server seed no re-gate is needed.
  const [aromas, setAromas] = useState<AromaSelection[]>(draft?.aromas ?? []);
  const [notes, setNotes] = useState(draft?.notes ?? '');
  // The impression screen's adaptive-fold behaviour: seed open when the
  // draft already carries structure engagement (a back-swipe round trip).
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cold deep-link / reload lands here with no draft — bounce to stage 1,
  // which owns the flow's entry.
  useEffect(() => {
    if (!draft) router.replace('/feed/check-in');
  }, [draft, router]);

  // Unmount write-back (refs so the cleanup sees the latest values): a
  // back-swipe to stage 1 keeps the rating in progress. Skips when the draft
  // is gone (successful post cleared it).
  const scoreRef = useRef(score); scoreRef.current = score;
  const flavorsRef = useRef(flavors); flavorsRef.current = flavors;
  const aromasRef = useRef(aromas); aromasRef.current = aromas;
  const notesRef = useRef(notes); notesRef.current = notes;
  useEffect(() => () => {
    const d = getCheckinDraft();
    if (d) setCheckinDraft({ ...d, score: scoreRef.current, flavors: flavorsRef.current, aromas: aromasRef.current, notes: notesRef.current });
  }, []);

  // Aroma search focus → the minimal shift that fits the search block above
  // the keyboard — the SHARED screen-side hook (one implementation with the
  // impression screen; see useAromaSearchScroll).
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, insets.bottom + FOOT_CLEARANCE);

  const onCheckIn = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    // Canonicalize rather than trim — stage 1's typing filter lets an NV-token
    // PREFIX through, so a half-typed value must not be sent. (The server
    // canonicalizes too; this keeps the official client's payload identical.)
    const cleanVintage = normalizeVintageText(draft.vintage);
    try {
      await createCheckin({
        wineName: draft.name.trim(),
        ...(draft.type ? { type: draft.type } : {}),
        ...(draft.producer.trim() ? { producer: draft.producer.trim() } : {}),
        ...(cleanVintage ? { vintage: cleanVintage } : {}),
        ...(draft.grape.trim() ? { grape: draft.grape.trim() } : {}),
        ...(draft.wineRegion.trim() ? { wineRegion: draft.wineRegion.trim() } : {}),
        ...(draft.wineCountry ? { wineCountry: draft.wineCountry } : {}),
        ...(draft.vinification.trim() ? { vinification: draft.vinification.trim() } : {}),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.purchaseUrl.trim() ? { purchaseUrl: draft.purchaseUrl.trim() } : {}),
        score,
        // Save-boundary normalisation (the rate screen's zero rule): filled
        // map when anything is rated, {} when every axis is None.
        flavors: fillFlavourZeros(flavors, 'wine', draft.type),
        // Already canonical (AromaInput gates every write); omitted = [] on
        // create, so the empty case just stays off the wire.
        ...(aromas.length ? { aromas } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(draft.photo ? { imageData: draft.photo.dataUrl } : {}),
        ...(draft.venue.trim() ? { venueName: draft.venue.trim() } : {}),
        ...(draft.city.trim() ? { city: draft.city.trim() } : {}),
      });
      // Surface the new post via refetch()-in-place — NEVER invalidate the
      // feed key (resets the infinite query toward page 1: the scroll-creep
      // bug — see feed/index.tsx). Fire-and-forget; the list updates behind
      // the pop. Clear the draft BEFORE dismissing so the unmount write-back
      // no-ops. dismiss(2) pops both stages back to the feed.
      clearCheckinDraft();
      queryClient.refetchQueries({ queryKey: FEED_KEY });
      router.dismiss(2);
    } catch (e) {
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : "Couldn't post it. Check your connection and try again.");
    }
  };

  if (!draft) return <View style={{ flex: 1 }} />; // bouncing (effect above)

  // Name lives in the title bar ("Rate It: <name>", Simon 2026-07-12); the
  // remaining identity (vintage · producer · type) stays as one caption line.
  const subLine = [draft.vintage, draft.producer, wineTypeLabel(draft.type)].filter(Boolean).join(' · ');

  return (
    // BottomSheetModalProvider in-screen (the app's per-screen pattern) — the
    // AromaInput sheets (selection + browse) need a sized provider/portal host.
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      {/* Same narrowed iOS edge-back zone as the impression screen — the
          structure-profile fill-tracks start ~20pt in and a leftward drag on
          the left column kept triggering an accidental back-pop with the OS
          default zone. Back-swipe from the very edge still works. */}
      <Stack.Screen options={{ gestureResponseDistance: { start: 15 } }} />
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={`Rate It: ${draft.name}`} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >
        {/* What you're checking in — the name is in the bar; this is the
            rest of the identity line. */}
        {subLine ? (
          <VText variant="small" color="inkSoft" style={{ marginBottom: 6 }}>{subLine}</VText>
        ) : null}

        {/* THE shared rating block (score · note · structure fold · aromas) —
            one component with the moment impression screen (Simon's 2026-07-12
            ruling; the impression's anatomy is the spec). Score stays optional
            — 0 = not rated; "just had it" is a legal check-in. All values are
            local-until-commit; the POST carries them. */}
        <RatingSection
          style={draft.type}
          score={score}
          onScore={setScore}
          notes={notes}
          onNotes={setNotes}
          flavors={flavors}
          onFlavors={setFlavors}
          aromas={aromas}
          onAromas={setAromas}
          onRequestAromaScroll={scrollAromaSearchTo}
        />
      </ScrollView>

      {/* Sticky "Check In" — the final action; error above, always visible. */}
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
        <Button title="Check In" loadingTitle="Checking In…" loading={saving} onPress={onCheckIn} bar block />
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}
