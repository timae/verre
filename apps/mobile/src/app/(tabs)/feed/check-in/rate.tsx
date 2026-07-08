import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fillFlavourZeros, resolveAxes } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { FlavourInput } from '@/components/scoring/FlavourInput';
import { ScoreInput } from '@/components/scoring/ScoreInput';
import { Disclosure, NotesField } from '@/components/moments/momentForm';
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
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [detailOpen, setDetailOpen] = useState(false);
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
  const notesRef = useRef(notes); notesRef.current = notes;
  useEffect(() => () => {
    const d = getCheckinDraft();
    if (d) setCheckinDraft({ ...d, score: scoreRef.current, flavors: flavorsRef.current, notes: notesRef.current });
  }, []);

  const onCheckIn = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      await createCheckin({
        wineName: draft.name.trim(),
        ...(draft.type ? { type: draft.type } : {}),
        ...(draft.producer.trim() ? { producer: draft.producer.trim() } : {}),
        ...(draft.vintage.trim() ? { vintage: draft.vintage.trim() } : {}),
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

  const titleLine = draft.name + (draft.vintage ? ` - ${draft.vintage}` : '');
  const subLine = [draft.producer, wineTypeLabel(draft.type)].filter(Boolean).join(' · ');

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Rate It" />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* What you're checking in — the ciSheet's name + sub line. */}
        <View style={{ marginBottom: 6 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{titleLine}</VText>
          {subLine ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>{subLine}</VText>
          ) : null}
        </View>

        {/* Score stays optional — 0 = not rated; "just had it" is a legal
            check-in. */}
        <ScoreInput value={score} onChange={setScore} />

        <Disclosure
          label="Add Structure Profile"
          open={detailOpen}
          onToggle={() => setDetailOpen((o) => !o)}
        >
          <VText variant="small" color="inkSoft" style={{ marginTop: -4 }}>
            Set each track to the intensity you perceive.
          </VText>
          <FlavourInput style={draft.type} value={flavors} onChange={setFlavors} />
        </Disclosure>

        <View style={{ marginTop: 18 }}>
          <NotesField label="Notes" placeholder="What stood out? (optional)" value={notes} onChange={setNotes} />
        </View>
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
  );
}
