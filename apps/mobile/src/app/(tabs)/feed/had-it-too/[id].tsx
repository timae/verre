import { Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { fillFlavourZeros, normalizePublicUserId, type AromaSelection } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { RatingSection } from '@/components/scoring/RatingSection';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { ToggleRow } from '@/components/moments/settingsParts';
import { MAX_COVER_BYTES, pickPhotoOrRemove } from '@/components/moments/momentForm';
import { GlassPen } from '@/components/ui/GlassPen';
import { labelLine } from '@/components/catalog/pickerParts';
import { createCheckin, patchCheckin, type CheckinPayload, type FeedItem } from '@/lib/api/feed';
import { HAD_IT_TOO_COPY, hadItTooBody, hadItTooPlace, hadItTooRefusal, hadItTooRefusalStoredNothing, type HadItTooPhoto } from '@/lib/hadItToo';
import { WhereYouHadIt } from '@/components/feed/WhereYouHadIt';
import { ApiError } from '@/lib/api/sessions';
import { getMomentDefaults, MOMENT_DEFAULTS_KEY } from '@/lib/api/momentDefaults';
import { MOMENT_HIDE_FROM_FEED_TITLE, RATE_HIDE_FROM_FEED_HELPER } from '@/lib/momentVisibilityCopy';
import { asColour, writeOutcome, type BottleLabel } from '@/lib/catalogChoice';
import { newClientId } from '@/lib/clientId';
import { dropUnmountedFeedCaches, invalidateProfileHeader, refetchFeedCaches } from '@/lib/feedCache';
import { useFeedPost } from '@/lib/useFeedPost';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { kindLabel } from '@/lib/momentFormat';
import { useMeId } from '@/lib/meId';
import { radius, useTheme } from '@/theme';

// "Had It Too" (the web's "had a sip", 08-feed § 5a): someone's standalone
// check-in, copied as your own. Ruled (Simon): standalone check-ins only, from
// someone you follow, never your own (the ⋯ rows show it only then); the SAME
// catalogue wine and year: the server copies the source's link, so the bottle
// is fixed here and the app sends no bottle fields (a different year is a
// normal Check In). The photo is the source's by default (the server copies it
// too); a new photo or Remove Photo (the photo's glass pen, the house photo
// edit) sends `copyPhoto: false`, and your own photo follows
// in the check-in's PATCH, as Check In's rate stage does. A pushed screen
// (ruled 2026-11-26, not the old quick sheet): the bar "Had It Too" with back,
// the bottle, the whole RatingSection, Post. Back returns to the post.
//
// Mounted on every tab stack (`<tab>/had-it-too/[id]`) and on every opened
// post's stack (`<tab>/[id]/had-it-too/[postId]`, where `id` is the opened
// post), like the post edit: `feedHref(mount, 'had-it-too')`. `?user=` / `source`
// name the list the post was opened from, so the screen reads THAT cache.

// The rating's saved shape, to tell whether it changed since the post (the
// rate stage's).
const ratingKey = (score: number, flavors: Record<string, number>, aromas: AromaSelection[], notes: string) =>
  JSON.stringify([score, flavors, aromas, notes.trim()]);

export default function HadItToo() {
  const insets = useSafeAreaInsets();
  const { id, postId, user, source } = useLocalSearchParams<{ id: string; postId?: string; user?: string; source?: string }>();
  // On an opened post's stack the copied post is `postId` (`id` is the post
  // the stack hangs off), like the edit.
  const feedItemId = Number(postId ?? id);
  const listUserId = normalizePublicUserId(user);
  const fromList = source === 'item' ? 'item' : undefined;
  const { feed, found } = useFeedPost(feedItemId, listUserId, fromList);
  const meId = useMeId();
  // Pinned at first sight, while it may be copied: a refetch can drop the post
  // from the loaded pages, and a follow that ends meanwhile is the server's to
  // refuse (with its copy), not a screen that vanishes mid-rating.
  const pinned = useRef<{ item: Extract<FeedItem, { type: 'checkin' }> } | null>(null);
  if (!pinned.current && found?.type === 'checkin' && meId != null && found.author.id !== meId && found.checkin.viewerFollowsAuthor) {
    pinned.current = { item: found };
  }
  const item = pinned.current?.item ?? null;
  if (!item) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title="Had It Too" />
        </View>
        {/* Still loading (a cold link, or your session at launch): nothing yet. */}
        {feed.isPending || meId == null ? null : <CenteredMessage title="This check-in isn’t available" />}
      </View>
    );
  }
  return <HadItTooForm source={item.checkin} />;
}

function HadItTooForm({ source }: { source: CheckinPayload }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const meId = useMeId();

  // The bottle as the source shows it (its catalogue snapshot): the copy takes
  // the same wine and year, so nothing here changes it.
  const [label] = useState<BottleLabel>(() => ({
    name: source.wineName, producer: source.producer ?? '', year: source.vintage ?? '',
    colour: asColour(source.colour), sparkling: source.sparkling,
  }));
  // One client id per screen: a retry after a lost answer answers the same
  // check-in (model change § 8a).
  const [occurrenceId, setOccurrenceId] = useState(() => newClientId());
  const [photo, setPhoto] = useState<HadItTooPhoto>(() => (source.imageUrl ? { kind: 'source' } : { kind: 'none' }));
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Where You Had It: the place THIS viewer is shown on the source (the
  // payload, after the author's Show My Locations), editable; none shown =
  // empty (lib/hadItToo.ts hadItTooPlace).
  const [place] = useState(() => hadItTooPlace(source));
  const [venue, setVenue] = useState(place.venue);
  const [city, setCity] = useState(place.city);
  const [score, setScore] = useState(0);
  const [flavors, setFlavors] = useState<Record<string, number>>({});
  const [aromas, setAromas] = useState<AromaSelection[]>([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The check-in landed but its photo didn't: its feed item id, and only the
  // photo goes again (Try Again), or Done leaves without it.
  const [postedId, setPostedId] = useState<number | null>(null);
  // 🔒 A post that MAY have landed (a 2xx, or no definite answer): what it sent
  // is final, the photo choice, the place and Hide from Feed alike, so a retry
  // (a replay of the same check-in) never disagrees with what was stored.
  const [frozen, setFrozen] = useState(false);
  const postedRating = useRef<string | null>(null);
  // Your own photo's PATCH succeeded: Try Again (a rating save that failed
  // after it) never uploads it a second time.
  const photoSent = useRef(false);

  // Hide from Feed (Moment Defaults), as on Check In's rate stage: preset from
  // your check-in default once a read of THIS screen loaded (never a guessed
  // off, never a cached copy older than a default just saved), then sent.
  const defaults = useQuery({ queryKey: MOMENT_DEFAULTS_KEY, queryFn: getMomentDefaults, refetchOnMount: 'always' });
  const [hidden, setHidden] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (hidden !== undefined) return;
    if (!defaults.data || !defaults.isFetchedAfterMount || !defaults.isSuccess || defaults.isFetching) return;
    setHidden(defaults.data.checkinHiddenFromFeed);
  }, [defaults.data, defaults.isFetchedAfterMount, defaults.isSuccess, defaults.isFetching, hidden]);

  // The latest rating values, for the saves after an await.
  const scoreRef = useRef(score); scoreRef.current = score;
  const flavorsRef = useRef(flavors); flavorsRef.current = flavors;
  const aromasRef = useRef(aromas); aromasRef.current = aromas;
  const notesRef = useRef(notes); notesRef.current = notes;

  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollYRef = useRef(0);
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, insets.bottom + FOOT_CLEARANCE);

  // Leave only while this screen is on top (the edit's rule): a look-in link
  // can open over it while the post is out, and a blind back() would pop THAT.
  // Covered: it closes itself once it is back on top; swiped away: nothing.
  const closeWhenBack = useRef(false);
  const leave = () => {
    if (navigation.isFocused()) router.back();
    else closeWhenBack.current = true;
  };
  useFocusEffect(useCallback(() => {
    if (!closeWhenBack.current) return;
    closeWhenBack.current = false;
    router.back();
  }, [router]));

  // Done: the new post shows through an in-place refetch (never invalidate,
  // lib/feedCache.ts), a popped profile list is dropped so it reloads, your
  // header's counts refresh; then back to the post. Once only.
  const left = useRef(false);
  const finish = () => {
    if (left.current) return;
    left.current = true;
    refetchFeedCaches(queryClient);
    dropUnmountedFeedCaches(queryClient);
    invalidateProfileHeader(queryClient, meId);
    leave();
  };

  // Your own photo, its own call after the post (a check-in's first photo
  // alone in a PATCH). False = it failed: the screen stays with Try Again.
  const sendPhoto = async (feedItemId: number): Promise<boolean> => {
    if (photoSent.current || photo.kind !== 'own') return true;
    try {
      await patchCheckin(feedItemId, { imageData: photo.dataUrl });
      photoSent.current = true;
      return true;
    } catch (e) {
      setPostedId(feedItemId);
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : 'Posted. The photo didn’t upload. Try again.');
      refetchFeedCaches(queryClient);
      return false;
    }
  };

  // The rating stays editable while only the photo is left: what changed since
  // it was last saved goes before the photo or before Done leaves (the rate
  // stage's loop, against the LATEST values).
  const saveRatingIfChanged = async (feedItemId: number): Promise<boolean> => {
    for (let round = 0; round < 3; round++) {
      const clean = fillFlavourZeros(flavorsRef.current, 'wine', label);
      const now = ratingKey(scoreRef.current, clean, aromasRef.current, notesRef.current);
      if (now === postedRating.current) return true;
      postedRating.current = null;
      try {
        await patchCheckin(feedItemId, { score: scoreRef.current, flavors: clean, aromas: aromasRef.current, notes: notesRef.current.trim() });
        postedRating.current = now;
      } catch (e) {
        setSaving(false);
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        setError(msg && msg !== 'http' ? msg : 'Your rating changes didn’t save. Try again.');
        return false;
      }
    }
    setSaving(false);
    setError('Your rating changed while saving. Tap again to save it.');
    return false;
  };

  const busy = useRef(false);
  const onPost = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setSaving(true);
    try {
      if (postedId !== null) {
        if (!(await saveRatingIfChanged(postedId))) return;
        if (!(await sendPhoto(postedId))) return;
        if (await saveRatingIfChanged(postedId)) finish();
        return;
      }
      const cleanFlavors = fillFlavourZeros(flavors, 'wine', label);
      let posted: { id: number; replayed: boolean };
      try {
        // 🔒 The source carries the bottle: no link, no bottle fields.
        posted = await createCheckin(hadItTooBody({ occurrenceId, sourceId: source.id, photo, venue, city, score, flavors: cleanFlavors, aromas, notes, hidden }));
      } catch (e) {
        setSaving(false);
        if (writeOutcome(e instanceof ApiError && e.status > 0 ? e.status : null) === 'unknown') {
          setFrozen(true);
          setError(HAD_IT_TOO_COPY.unconfirmed);
          return;
        }
        // Someone else's id (practically never): the next try gets a new one.
        if (e instanceof ApiError && e.status === 409) setOccurrenceId(newClientId());
        // A refusal answered after the server's replay check proves nothing
        // was stored (a retry after a lost answer included): the choices may
        // change again. Any other refusal leaves the freeze as it was.
        if (hadItTooRefusalStoredNothing(e instanceof ApiError ? e : null)) setFrozen(false);
        setError(hadItTooRefusal(e instanceof ApiError ? e : null));
        return;
      }
      setFrozen(true);
      postedRating.current = ratingKey(score, cleanFlavors, aromas, notes);
      // A replay answers the check-in as it was first stored: the rating as it
      // is now goes as an edit (the photo and the place were frozen with the
      // first try, so they match what was stored).
      if (posted.replayed) {
        try {
          await patchCheckin(posted.id, { score, flavors: cleanFlavors, aromas, notes: notes.trim() });
        } catch (e) {
          setSaving(false);
          const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
          setError(msg && msg !== 'http' ? msg : 'Posted, but your changes didn’t save. Try again.');
          refetchFeedCaches(queryClient);
          return;
        }
      }
      if (!(await sendPhoto(posted.id))) return;
      // An edit of the rating made while the post was in flight.
      if (!(await saveRatingIfChanged(posted.id))) { setPostedId(posted.id); return; }
      finish();
    } finally {
      busy.current = false;
    }
  };

  const locked = frozen || postedId !== null || saving;
  const shownUri = photo.kind === 'source' ? source.imageUrl : photo.kind === 'own' ? photo.previewUri : null;
  // The house photo edit (Edit Profile's photo): the glass pen opens Take
  // Photo / Choose from Library, plus Remove Photo when there is one. A pick
  // replaces the photo (yours, sent in the PATCH after the post), Remove leaves
  // none; either way the source's photo is not copied. Cancel changes nothing.
  const onEditPhoto = async () => {
    if (locked) return;
    setPhotoError(null);
    const picked = await pickPhotoOrRemove(shownUri ? 'Remove Photo' : null, MAX_COVER_BYTES);
    if (!picked) return; // Cancel
    if (picked === 'remove') {
      setPhoto({ kind: 'none' });
      return;
    }
    if ('failed' in picked) {
      setPhotoError('Couldn’t use that photo. Try another.');
      return;
    }
    setPhoto({ kind: 'own', ...picked });
  };
  const subLine = [label.producer, kindLabel(label)].filter(Boolean).join(' · ');

  return (
    // In-screen provider: the AromaInput sheets need a sized host (the rate
    // stage's pattern).
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      {/* The rate stage's narrowed edge-back zone: the structure tracks start
          ~20pt in, and a leftward drag there kept popping the screen. */}
      <Stack.Screen options={{ gestureResponseDistance: { start: 15 } }} />
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Had It Too" />
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
        {/* The bottle, fixed: its photo with the house glass pen (a tap on
            the photo opens it full screen, the pen changes it; without a
            photo the whole tile is the pen's button), name + year, producer. */}
        <View style={{ flexDirection: 'row', gap: 12, padding: 10, marginBottom: 16, borderRadius: radius.md, backgroundColor: theme.surface }}>
          {shownUri ? (
            <View style={{ width: 72, height: 72 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Open photo fullscreen" onPress={() => setFullscreen(true)}>
                <Image key={shownUri} source={{ uri: shownUri }} alt="" style={{ width: 72, height: 72, borderRadius: radius.sm }} contentFit="cover" />
              </Pressable>
              <GlassPen inset={4} onPress={onEditPhoto} disabled={locked} />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change Photo"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={onEditPhoto}
              style={({ pressed }) => ({ width: 72, height: 72, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
            >
              <Icon name="cam" size={20} color={theme.inkFaint} />
              <GlassPen inset={4} disabled={locked} />
            </Pressable>
          )}
          <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
            <VText surface="compactList" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{labelLine(label)}</VText>
            {subLine ? <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1} style={{ marginTop: 1 }}>{subLine}</VText> : null}
          </View>
        </View>
        {photoError ? (
          <VText variant="small" style={{ marginTop: -8, marginBottom: 8, color: theme.critical }}>{photoError}</VText>
        ) : null}
        {shownUri ? <FullscreenImage uri={shownUri} visible={fullscreen} label="Photo" onClose={() => setFullscreen(false)} /> : null}

        {/* Where You Had It: Check In's field, prefilled from the place shown
            on the source; read-only once the post may have landed. */}
        <View style={{ marginBottom: 12 }}>
          <WhereYouHadIt venue={venue} city={city} onVenue={setVenue} onCity={setCity} editable={!locked} />
        </View>

        {/* THE shared rating block (score · note · structure · aromas), the
            check-in rate stage's. Score stays optional (0 = not rated). */}
        <RatingSection
          kind={label}
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
        {/* Hide from Feed (Moment Defaults), read-only once the post may have
            landed (a retry re-sends the same body). */}
        {hidden !== undefined ? (
          <ToggleRow
            title={MOMENT_HIDE_FROM_FEED_TITLE}
            subtitle={RATE_HIDE_FROM_FEED_HELPER}
            value={hidden}
            disabled={frozen || postedId !== null}
            busy={saving}
            onChange={setHidden}
          />
        ) : null}
      </ScrollView>

      {/* Sticky Post: the error above it, always visible. */}
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
              // Done skips only the photo: a changed rating is saved first.
              onPress={async () => {
                if (saving || postedId === null || busy.current) return;
                busy.current = true;
                setSaving(true);
                setError(null);
                try {
                  if (await saveRatingIfChanged(postedId)) finish();
                } finally {
                  busy.current = false;
                }
              }}
              bar
              style={{ flex: 1 }}
            />
            {/* "Uploading…" only while your photo is still to go up; a retry
                of a rating save alone says "Saving…". */}
            <Button title="Try Again" loadingTitle={photo.kind === 'own' && !photoSent.current ? 'Uploading…' : 'Saving…'} loading={saving} onPress={onPost} bar style={{ flex: 1 }} />
          </View>
        ) : (
          <Button title="Post" loadingTitle="Posting…" loading={saving} onPress={onPost} bar block />
        )}
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}
