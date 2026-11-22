import { useNavigation, Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { fillFlavourZeros, resolveAxes, type AromaSelection } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { RatingSection } from '@/components/scoring/RatingSection';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { ApiError } from '@/lib/api/sessions';
import { createCheckin, patchCheckin } from '@/lib/api/feed';
import { linkBody, writeOutcome } from '@/lib/catalogChoice';
import { newClientId } from '@/lib/clientId';
import { authClient } from '@/lib/authClient';
import { dropUnmountedFeedCaches, invalidateProfileHeader, refetchFeedCaches } from '@/lib/feedCache';
import { clearCheckinDraft, getCheckinDraft, setCheckinDraft } from '@/lib/checkinDraft';
import { popsPast } from '@/lib/pickerFlow';
import { checkinHref, useSessionTab } from '@/lib/sessionStack';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { kindLabel } from '@/lib/momentFormat';
import { useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';

// Standalone check-in create, STAGE 2 of 2: the rating moment (Simon's
// two-stage ruling — details first, then "you rate it and check it in").
// Reads the details from lib/checkinDraft.ts (written by stage 1's "Rate It"),
// owns score/structure/notes, and fires the actual POST. The 02e rate blocks
// (ScoreInput + the structure fold) over the check-in identity line.
//
// Rating state writes BACK to the draft on unmount so a back-swipe to stage 1
// (tweak a detail) and a second "Rate It" push restores it. A successful post
// clears the draft first, so that write-back no-ops.

// The rating's saved shape, to tell whether it changed since the post.
const ratingKey = (score: number, flavors: Record<string, number>, aromas: AromaSelection[], notes: string) =>
  JSON.stringify([score, flavors, aromas, notes.trim()]);

export default function CheckinRate() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  // The flow's own stack (Feed, or You from your Impressions: lists plan D8).
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const meId = useMeId();

  // Read once at mount — the draft is stable while this screen lives (stage 1
  // only rewrites it on a fresh "Rate It" push, which re-mounts this screen).
  const [draft] = useState(() => getCheckinDraft(mount.tab));

  const [score, setScore] = useState(draft?.score ?? 0);
  // Prune rated axes to the CURRENT wine's set: on a back-and-forth round
  // trip the wine may have changed under a saved rating (sparkling → still
  // drops Bubbles), and the server 400s a non-zero off-kind key.
  const kind = draft?.choice.label ?? null;
  const [flavors, setFlavors] = useState<Record<string, number>>(() => {
    if (!draft) return {};
    const allowed = new Set(resolveAxes('wine', draft.choice.label).map((a) => a.k));
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
  // The check-in landed but its photo didn't (ADR-0009: stay and retry): its
  // feed item id, and only the photo goes again.
  const [postedId, setPostedId] = useState<number | null>(null);
  // The flow's client id, in state (review r1: the draft is a mount snapshot, so
  // a fresh id after a 409 written only to the store was never sent).
  const [occurrenceId, setOccurrenceId] = useState(draft?.occurrenceId ?? '');
  // The rating as it was last saved (the post, or a later edit).
  const postedRating = useRef<string | null>(null);
  // The latest draft (the store), not the mount snapshot, for every write-back.
  const latest = () => getCheckinDraft(mount.tab) ?? draft!;

  // Cold deep-link / reload lands here with no draft — bounce to stage 1,
  // which owns the flow's entry.
  useEffect(() => {
    if (!draft) router.replace(checkinHref(mount));
  }, [draft, router, mount]);

  // Unmount write-back (refs so the cleanup sees the latest values): a
  // back-swipe to stage 1 keeps the rating in progress. Skips when the draft
  // is gone (successful post cleared it).
  const scoreRef = useRef(score); scoreRef.current = score;
  const flavorsRef = useRef(flavors); flavorsRef.current = flavors;
  const aromasRef = useRef(aromas); aromasRef.current = aromas;
  const notesRef = useRef(notes); notesRef.current = notes;
  useEffect(() => () => {
    const d = getCheckinDraft(mount.tab);
    if (d) setCheckinDraft(mount.tab, { ...d, score: scoreRef.current, flavors: flavorsRef.current, aromas: aromasRef.current, notes: notesRef.current });
  }, []);

  // Aroma search focus → the minimal shift that fits the search block above
  // the keyboard — the SHARED screen-side hook (one implementation with the
  // impression screen; see useAromaSearchScroll).
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollYRef = useRef(0);
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, insets.bottom + FOOT_CLEARANCE);

  // Done: surface the new post via refetch()-in-place — NEVER invalidate the
  // feed key (resets the infinite query toward page 1: the scroll-creep bug —
  // see lib/feedCache.ts). Clear the draft BEFORE dismissing so the unmount
  // write-back no-ops. Then pop the whole check-in (the search, any catalogue
  // pages, the details and this stage: ruled 2026-11-22, they are screens of
  // their own) back to where it started.
  // Leaving happens once (Codex r1: Done during a retry's upload, then the
  // upload's own finish, would dismiss twice and pop past the list).
  const left = useRef(false);
  const finish = () => {
    if (left.current) return;
    left.current = true;
    clearCheckinDraft(mount.tab);
    refetchFeedCaches(queryClient);
    // A popped profile list can't show the new post; drop it so it reloads.
    dropUnmountedFeedCaches(queryClient);
    // Your header's counts (impressions, tile photo, average) changed too.
    invalidateProfileHeader(queryClient, meId);
    const st = navigation.getState();
    router.dismiss((st ? popsPast(st.routes.map((r) => r.name), st.index, 'check-in/index') : null) ?? 2);
  };
  // The photo, its own call after the post (a check-in's first photo alone in
  // a PATCH). False = it failed: the screen stays with Try Again.
  const sendPhoto = async (feedItemId: number): Promise<boolean> => {
    const tried = !!latest().photoTried;
    if (!draft?.photo && !tried) return true;
    try {
      if (draft?.photo) {
        setCheckinDraft(mount.tab, { ...latest(), photoTried: true });
        await patchCheckin(feedItemId, { imageData: draft.photo.dataUrl });
      } else {
        // Cleared after an upload that may have landed: remove it.
        await patchCheckin(feedItemId, { imageData: null });
        setCheckinDraft(mount.tab, { ...latest(), photoTried: false });
      }
      return true;
    } catch (e) {
      setPostedId(feedItemId);
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : 'Checked in. The photo didn’t upload. Try again.');
      refetchFeedCaches(queryClient);
      return false;
    }
  };

  // The rating stayed editable while only the photo was left: what changed
  // since it was last saved goes before the photo or before Done leaves
  // (Codex r1 / r2). The baseline is UNKNOWN while an update is in flight: a
  // lost answer must not let a later "unchanged" skip the save.
  const saveRatingIfChanged = async (feedItemId: number): Promise<boolean> => {
    if (!draft) return true;
    // Until the LATEST values (refs) are the confirmed ones (Codex r3: an edit
    // made during this PATCH, or during the upload before it, counts too).
    for (let round = 0; round < 3; round++) {
      const cur = { score: scoreRef.current, flavors: flavorsRef.current, aromas: aromasRef.current, notes: notesRef.current };
      const clean = fillFlavourZeros(cur.flavors, 'wine', draft.choice.label);
      const now = ratingKey(cur.score, clean, cur.aromas, cur.notes);
      if (now === postedRating.current) return true;
      postedRating.current = null;
      try {
        await patchCheckin(feedItemId, { score: cur.score, flavors: clean, aromas: cur.aromas, notes: cur.notes.trim() });
        postedRating.current = now;
      } catch (e) {
        setSaving(false);
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        setError(msg && msg !== 'http' ? msg : 'Your rating changes didn’t save. Try again.');
        return false;
      }
    }
    // Still moving after three saves: stay, the next tap saves the rest.
    setSaving(false);
    setError('Your rating changed while saving. Tap again to save it.');
    return false;
  };

  const onCheckIn = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    if (postedId !== null) {
      if (!(await saveRatingIfChanged(postedId))) return;
      if (!(await sendPhoto(postedId))) return;
      // An edit made during the upload (Codex r3).
      if (await saveRatingIfChanged(postedId)) finish();
      return;
    }
    // Save-boundary normalisation (the rate screen's zero rule): filled map
    // when anything is rated, {} when every axis is None.
    const cleanFlavors = fillFlavourZeros(flavors, 'wine', draft.choice.label);
    let posted: { id: number; replayed: boolean };
    try {
      posted = await createCheckin({
        occurrenceId,
        ...linkBody(draft.choice),
        ...(draft.vinification.trim() ? { vinification: draft.vinification.trim() } : {}),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.purchaseUrl.trim() ? { purchaseUrl: draft.purchaseUrl.trim() } : {}),
        score,
        flavors: cleanFlavors,
        // Already canonical (AromaInput gates every write); omitted = [] on
        // create, so the empty case just stays off the wire.
        ...(aromas.length ? { aromas } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(draft.venue.trim() ? { venueName: draft.venue.trim() } : {}),
        ...(draft.city.trim() ? { city: draft.city.trim() } : {}),
      });
    } catch (e) {
      setSaving(false);
      const outcome = writeOutcome(e instanceof ApiError && e.status > 0 ? e.status : null);
      // 🔒 It MAY have landed: the choice freezes (ADR-0009), so the retry
      // sends the same id and wine, never an edited one.
      if (outcome === 'unknown') {
        setCheckinDraft(mount.tab, { ...latest(), frozen: true });
        setError('We couldn’t confirm it was checked in. Try again.');
        return;
      }
      // Someone else's id (practically never): the next try gets a new one.
      if (e instanceof ApiError && e.status === 409) {
        const fresh = newClientId();
        setOccurrenceId(fresh);
        setCheckinDraft(mount.tab, { ...latest(), occurrenceId: fresh });
      }
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : "Couldn't post it. Check your connection and try again.");
      return;
    }
    setCheckinDraft(mount.tab, { ...latest(), frozen: true });
    postedRating.current = ratingKey(score, cleanFlavors, aromas, notes);
    // A replay answers the check-in as it was first stored: what changed in the
    // draft since (a second pass after a lost answer) goes as an edit (review r1).
    if (posted.replayed) {
      try {
        await patchCheckin(posted.id, {
          vinification: draft.vinification.trim(), description: draft.description.trim(), purchaseUrl: draft.purchaseUrl.trim(),
          venueName: draft.venue.trim(), city: draft.city.trim(),
          score, flavors: cleanFlavors, aromas, notes: notes.trim(),
        });
      } catch (e) {
        setSaving(false);
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        setError(msg && msg !== 'http' ? msg : 'Checked in, but your changes didn’t save. Try again.');
        refetchFeedCaches(queryClient);
        return;
      }
    }
    if (!(await sendPhoto(posted.id))) return;
    // An edit of the rating made while the post was in flight (Codex r2's case,
    // on the way out).
    if (!(await saveRatingIfChanged(posted.id))) { setPostedId(posted.id); return; }
    finish();
  };

  if (!draft) return <View style={{ flex: 1 }} />; // bouncing (effect above)

  // Name lives in the title bar ("Rate It: <name>", Simon 2026-07-12); the
  // remaining identity (year · producer · kind) stays as one caption line.
  const label = draft.choice.label;
  const subLine = [label.year, label.producer, kindLabel(label)].filter(Boolean).join(' · ');

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
        <VBar title={`Rate It: ${label.name}`} />
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
          kind={kind}
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
        {postedId !== null ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              title="Done"
              variant="secondary"
              disabled={saving}
              // Done skips only the photo: a changed rating is saved first (Codex r2).
              onPress={async () => {
                if (saving || postedId === null) return;
                setSaving(true);
                setError(null);
                if (await saveRatingIfChanged(postedId)) finish();
              }}
              bar
              style={{ flex: 1 }}
            />
            <Button title="Try Again" loadingTitle="Uploading…" loading={saving} onPress={onCheckIn} bar style={{ flex: 1 }} />
          </View>
        ) : (
          <Button title="Check In" loadingTitle="Checking In…" loading={saving} onPress={onCheckIn} bar block />
        )}
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}
