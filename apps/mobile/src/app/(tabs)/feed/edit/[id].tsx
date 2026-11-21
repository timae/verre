import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { fillFlavourZeros, gateAromaSelections, normalizePublicUserId, type AromaSelection } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { RatingSection } from '@/components/scoring/RatingSection';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import {
  patchCheckin, patchSessionRating,
  type CheckinPayload, type FeedItem, type SessionFeedWine,
} from '@/lib/api/feed';
import { authClient } from '@/lib/authClient';
import { invalidateProfileHeader, markFeedPostDeleted, refetchFeedCaches, updateFeedCaches } from '@/lib/feedCache';
import { closeOpenedPost, closePost, feedHref, feedListHref, useSessionTab } from '@/lib/sessionStack';
import { useFeedPost } from '@/lib/useFeedPost';
import { ApiError } from '@/lib/api/sessions';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { clearCheckinEditMeta, getCheckinEditMeta, setCheckinEditMeta } from '@/lib/checkinEdit';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { kindLabel } from '@/lib/momentFormat';
import { asColour, linkBody, writeOutcome } from '@/lib/catalogChoice';
import { radius, useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';

// Edit a feed post (Simon, 2026-07-17). Reached from the card / detail ⋯
// menus, owner-only. Two variants over ONE screen:
//   - SESSION check-in (`?wine=<wineId>`): edit the RATING of that impression
//     (score · note · structure · aromas) — the wine identity belongs to the
//     moment, so nothing else is editable here.
//   - STANDALONE: the same rating block, topped by the impression SQUARE — a
//     tappable card (photo · name · producer) that pushes ./details for the
//     wine-metadata edit; the square re-reads the shared edit store on focus.
// Save PATCHes /api/checkins/:id (partial semantics; aromas present-replaces)
// and maps the response into EVERY feed cache IN PLACE (the like-flow
// pattern — never invalidate, that resets the infinite query). `?user=` names
// the list the edit was opened from (network feed or a profile feed): the
// screen reads that cache. Mounted under Feed AND You (re-export mirror). An edit that
// EMPTIES a session rating reaps it server-side; if the post itself is gone
// (`feedItemDeleted`) the feed refetches in place instead.

export default function EditFeedPost() {
  const { theme } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { id, postId, wine: wineParam, user, source } = useLocalSearchParams<{ id: string; postId?: string; wine?: string; user?: string; source?: string }>();
  // Mounted on a tab stack (`edit/[id]`) or on an opened post's own stack
  // (`[id]/edit/[postId]`, where `id` is the opened post): the edited post is
  // `postId` there.
  const feedItemId = Number(postId ?? id);
  const listUserId = normalizePublicUserId(user);
  const tab = useSessionTab();
  const meId = useMeId();

  // Same cache-read + pin discipline as the detail screen: the poll can drop
  // a page-boundary item mid-edit; once seen, keep editing the pinned copy.
  // `source: 'item'` = the post was opened from a profile tile list (lists
  // plan D9): its own item query, and the "post is gone" exit pops back to
  // that list (closePost), not to a profile.
  const fromList = source === 'item' ? 'item' : undefined;
  const { found } = useFeedPost(feedItemId, listUserId, fromList);
  const pinnedRef = useRef<FeedItem | null>(null);
  if (found) pinnedRef.current = found;
  const item = found ?? pinnedRef.current;

  const isSession = item?.type === 'session';
  const wine: SessionFeedWine | CheckinPayload | null = item
    ? item.type === 'session'
      ? (wineParam ? item.session.wines.find((w) => w.id === wineParam) ?? null : null)
      : item.checkin
    : null;
  // The bottle's kind for the axes (Bubbles from `sparkling`).
  const bottleKind = wine ? { sparkling: wine.sparkling } : null;
  const wineName = item?.type === 'session'
    ? (wine as SessionFeedWine | null)?._blind
      ? 'Hidden impression'
      : (wine as SessionFeedWine | null)?.name ?? ''
    : (wine as CheckinPayload | null)?.wineName ?? '';

  const [score, setScore] = useState(0);
  const [notes, setNotes] = useState('');
  const [flavors, setFlavors] = useState<Record<string, number>>({});
  const [aromas, setAromas] = useState<AromaSelection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed ONCE from the cached payload (the impression screen's pattern) — the
  // feed cache IS the archive truth for these fields. Aromas re-canonicalize
  // through the core gate on seed. ⚠️ The gate is ALL-OR-NOTHING: one stored
  // id it can't resolve (a re-homed taxonomy id, or a binary whose bundled
  // taxonomy is older than the server's) nulls the whole seed. In that state
  // the save must NOT send `aromas` (present-replaces would silently wipe the
  // stored list) unless the user actually edits them — tracked by the two
  // refs below.
  const seededRef = useRef(false);
  const aromasSeedFailed = useRef(false);
  const aromasDirty = useRef(false);
  useEffect(() => {
    if (seededRef.current || !wine) return;
    seededRef.current = true;
    setScore(wine.score ?? 0);
    setNotes(wine.notes ?? '');
    setFlavors((wine.flavors as Record<string, number>) ?? {});
    const seedGate = gateAromaSelections(wine.aromas);
    aromasSeedFailed.current = (wine.aromas?.length ?? 0) > 0 && !!seedGate.error;
    setAromas(seedGate.value ?? []);
    if (item?.type === 'checkin') {
      const c = item.checkin;
      setCheckinEditMeta({
        feedItemId,
        label: { name: c.wineName, producer: c.producer ?? '', year: c.vintage ?? '', colour: asColour(c.colour), sparkling: c.sparkling },
        choice: null,
        vinification: c.vinification ?? '',
        description: c.description ?? '',
        purchaseUrl: c.purchaseUrl ?? '',
        venue: c.venueName ?? '',
        city: c.city ?? '',
        photo: undefined,
        existingImageUrl: c.imageUrl,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wine]);
  // The store is edit-session-scoped: clear on unmount so a later create/edit
  // can't inherit it.
  useEffect(() => () => clearCheckinEditMeta(), []);

  // Re-read the shared meta store when the details sub-screen pops back.
  const [metaTick, setMetaTick] = useState(0);
  useFocusEffect(useCallback(() => { setMetaTick((t) => t + 1); }, []));
  const meta = getCheckinEditMeta();
  void metaTick;

  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollYRef = useRef(0);
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, insets.bottom + FOOT_CLEARANCE);

  const onSave = async () => {
    if (!item || saving) return;
    setError(null);
    setSaving(true);
    try {
      // A failed aroma seed + untouched aromas → OMIT the field (the server
      // preserves omitted aromas); anything else sends the current list.
      const aromasPatch = aromasSeedFailed.current && !aromasDirty.current ? {} : { aromas };
      if (item.type === 'session') {
        // Your own post: the row carries its wine id (it was found by it,
        // above). The write needs the id; the cache updates key on the rating.
        const w = wine as SessionFeedWine;
        if (!w.id) { setError('Could not save. Try again.'); return; }
        const res = await patchSessionRating(feedItemId, {
          wineId: w.id,
          score,
          flavors: fillFlavourZeros(flavors, 'wine', bottleKind),
          ...aromasPatch,
          notes,
        });
        if (res.feedItemDeleted || res.reaped) {
          // The rating (and possibly the post) is gone. Reflect it in the
          // cache IMMEDIATELY (the delete flows' discipline): a refetch alone
          // leaves the reaped wine actionable on the card — a follow-up
          // "Delete Rating" would 404. The in-place refetch then reconciles
          // (fire-and-forget: the drop already fixed actionability, and Save
          // shouldn't block on it).
          await applyToFeedCache((it) => {
            if (it.type !== 'session' || it.session.id !== feedItemId) return it;
            const wines = it.session.wines.filter((sw) => sw.ratingId !== w.ratingId);
            if (wines.length === 0 || res.feedItemDeleted) return null;
            return { ...it, session: { ...it.session, wines } };
          });
          refetchFeedCaches(queryClient);
          invalidateProfileHeader(queryClient, meId);
          if (res.feedItemDeleted) {
            markFeedPostDeleted(feedItemId);
            // The POST is gone. When the edit was opened from the impression
            // detail, plain back() would land on it — and that screen pins its
            // copy by design (frozen read surface), so it would render the
            // deleted post. Pop the whole way to the list it came from.
            // On an opened post's stack: the opened post ITSELF went → close
            // it whole (one modal; lib/sessionStack.ts closeOpenedPost);
            // another post (a card) → back to the list on that stack.
            if (tab.post === String(feedItemId) && closeOpenedPost(navigation, tab.post)) return;
            if (fromList === 'item' && closePost(navigation, String(feedItemId))) return;
            router.dismissTo(feedListHref(tab, listUserId, meId));
            return;
          }
        } else {
          await applyToFeedCache((it) => {
            if (it.type !== 'session' || it.session.id !== feedItemId) return it;
            return {
              ...it,
              session: {
                ...it.session,
                wines: it.session.wines.map((sw) =>
                  sw.ratingId === w.ratingId
                    ? { ...sw, score: res.score, flavors: res.flavors, aromas: res.aromas, notes: res.notes }
                    : sw,
                ),
              },
            };
          });
        }
      } else {
        const m = meta;
        if (!m) throw new Error('nothing to save');
        let res: Awaited<ReturnType<typeof patchCheckin>>;
        try {
          res = await patchCheckin(feedItemId, {
          // A re-link (ADR-0009): the snapshot follows the new wine.
          ...(m.choice ? linkBody(m.choice) : {}),
          vinification: m.vinification,
          description: m.description,
          purchaseUrl: m.purchaseUrl,
          venueName: m.venue,
          city: m.city,
          score,
          flavors: fillFlavourZeros(flavors, 'wine', m.choice?.label ?? m.label),
          ...aromasPatch,
          notes,
          ...(m.photo !== undefined ? { imageData: m.photo === null ? null : m.photo.dataUrl } : {}),
          });
        } catch (e) {
          // A re-link that adds a wine may have landed without an answer:
          // never send it again (it would add the wine twice). Close and say so.
          if (m.choice?.kind === 'create' && writeOutcome(e instanceof ApiError && e.status > 0 ? e.status : null) === 'unknown') {
            refetchFeedCaches(queryClient);
            router.back();
            Alert.alert('Not Confirmed', 'We couldn’t confirm the change. Reopen the check-in and check.');
            return;
          }
          throw e;
        }
        await applyToFeedCache((it) => {
          if (it.type !== 'checkin' || it.checkin.id !== feedItemId) return it;
          return {
            ...it,
            checkin: {
              ...it.checkin,
              wineName: res.wineName,
              producer: res.producer,
              vintage: res.vintage,
              grape: res.grape,
              colour: res.colour,
              sparkling: res.sparkling,
              abv: res.abv,
              wineRegion: res.wineRegion,
              wineCountry: res.wineCountry,
              vinification: res.vinification,
              description: res.description,
              purchaseUrl: res.purchaseUrl,
              score: res.score,
              flavors: res.flavors,
              aromas: res.aromas,
              notes: res.notes,
              imageUrl: res.imageUrl,
              venueName: res.venueName,
              city: res.city,
              country: res.country,
            },
          };
        });
      }
      // Your header (average, tile photo) can change with any save.
      invalidateProfileHeader(queryClient, meId);
      router.back();
    } catch (e) {
      // Friendly-copy gate (the delete flows' rule): surface the server's
      // message only for resolved 4xx — a 500/timeout must not print raw
      // internals in the sticky bar.
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  // Cancel-then-write across every feed cache (lib/feedCache.ts): an
  // in-flight refetch whose GET left before the PATCH committed would
  // otherwise resolve after this write and revert the card until the next
  // refetch. `null` drops the item.
  const applyToFeedCache = (map: (item: FeedItem) => FeedItem | null) => updateFeedCaches(queryClient, map);

  if (!item || !wine) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title="Edit" />
        </View>
        <CenteredMessage title="This post isn’t available to edit" />
      </View>
    );
  }

  const previewUri = meta?.photo === null ? null : meta?.photo?.previewUri ?? meta?.existingImageUrl ?? null;

  return (
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={isSession ? `Edit: ${wineName}` : 'Edit Check-In'} />
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
        {isSession ? (
          // The moment's identity line — context, not editable from here.
          <VText variant="small" color="inkSoft" style={{ marginBottom: 6 }}>
            {[(wine as SessionFeedWine).producer, kindLabel(wine)].filter(Boolean).join(' · ') || 'Your rating in this moment'}
          </VText>
        ) : meta ? (
          // The impression SQUARE (Simon's spec): tap to edit the wine itself;
          // the rating block sits below.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit Impression Details"
            onPress={() => router.push(feedHref(tab, 'edit/details', { user: listUserId ?? undefined }))}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 12,
              padding: 10, marginBottom: 16, borderRadius: radius.md,
              backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
            })}
          >
            {previewUri ? (
              <Image source={{ uri: previewUri }} alt="" style={{ width: 56, height: 56, borderRadius: radius.sm }} resizeMode="cover" />
            ) : (
              <View style={{ width: 56, height: 56, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="cam" size={20} color={theme.inkFaint} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <VText numberOfLines={1} variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {(meta.choice?.label ?? meta.label).name || 'Untitled'}
              </VText>
              <VText numberOfLines={1} variant="small" color="inkSoft" style={{ marginTop: 1 }}>
                {[(meta.choice?.label ?? meta.label).producer, (meta.choice?.label ?? meta.label).year, kindLabel(meta.choice?.label ?? meta.label)].filter(Boolean).join(' · ') || 'Tap to edit the impression'}
              </VText>
            </View>
            <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Edit ›</VText>
          </Pressable>
        ) : null}

        <RatingSection
          kind={isSession ? bottleKind : meta?.choice?.label ?? meta?.label ?? null}
          score={score}
          onScore={setScore}
          notes={notes}
          onNotes={setNotes}
          flavors={flavors}
          onFlavors={setFlavors}
          aromas={aromas}
          onAromas={(next) => { aromasDirty.current = true; setAromas(next); }}
          onRequestAromaScroll={scrollAromaSearchTo}
        />
      </ScrollView>

      {/* Sticky Save — the create-flow bar anatomy. */}
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
        <Button title="Save" loadingTitle="Saving…" loading={saving} onPress={onSave} bar block />
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}
