import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { personLine } from '@/components/people/PeopleRow';
import { ScanResult, useVerreScanner } from '@/components/people/scan';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FriendRow, FriendRowBadge, FriendRowButton } from '@/components/ui/FriendRow';
import { Icon } from '@/components/ui/Icon';
import { QrCode } from '@/components/ui/QrCode';
import { QuickAddChip } from '@/components/ui/QuickAddChip';
import { Sheet } from '@/components/ui/Sheet';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { ShareFooterButton } from '@/components/ui/ShareFooterButton';
import { VText } from '@/components/ui/VText';
import { MY_ACCOUNT_KEY, getMyAccount } from '@/lib/api/me';
import { SEARCH_KEY, TASTED_WITH_KEY, getTastedWith, searchPeople, type TastedWith } from '@/lib/api/people';
import { profileQueryOptions } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { lastMomentLine } from '@/lib/momentFormat';
import { relate, usePersonBusy } from '@/lib/relationship';
import { type VerreCode } from '@/lib/scanCode';
import { fuzzyIncludes } from '@/lib/search';
import { feedHref, useSessionTab } from '@/lib/sessionStack';
import { profileLink, shareProfile } from '@/lib/shareProfile';
import { usePushGuard } from '@/lib/usePushGuard';
import { useTheme } from '@/theme';

// Add Friends (handoff 04·12 / 12a / 12c / 12d): one sheet, no route, from
// your profile's ⋯ and People's + Add / code button. The moment invite
// sheet's anatomy (02c·I1): your QR card (others scan it to reach your
// profile), quick-add chips of "People you tasted with", a search field that
// opens the full search pane, and Share Profile Link. Scan (top right) is
// the iPhone's own scanner (D8; `components/people/scan.tsx`, shared with
// Moments home); a Verre code shows its result HERE, nothing happens on its
// own (a moment: its preview, then Join); any other code gets an alert.
//
// Rulings carried: the QR sits flat on the sheet like the invite sheet's (no
// code-card panel, Simon's invite ruling); the chips are a SNAPSHOT taken when
// the sheet opens, so a followed chip keeps its ✓ until the sheet closes
// (relationship writes drop followed people from the tasted-with cache); a ✓
// is inert (unfollow lives on People rows and the profile). Any push out of
// the sheet closes it FIRST (lib/sheetVisibility's count would otherwise
// leave the tab pill hidden). The screen that renders this wraps itself in a
// BottomSheetModalProvider.

type Pane = 'main' | 'search' | 'result';

export function AddFriendsSheet({ open, onClose, meId }: { open: boolean; onClose: () => void; meId: number }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const guard = usePushGuard();
  const sessionName = authClient.useSession().data?.user.name;

  const [pane, setPane] = useState<Pane>('main');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<VerreCode | null>(null);
  const [chips, setChips] = useState<TastedWith[] | null>(null);
  const [done, setDone] = useState<Set<number>>(() => new Set());

  // Your card works even when your profile failed to load: the id is the
  // session's, the name the users row's (GET /api/me/account; Better Auth's
  // copy is stale after a rename), the photo falls back to initials.
  const meQ = useQuery({ ...profileQueryOptions(meId), enabled: open });
  const acctQ = useQuery({ queryKey: MY_ACCOUNT_KEY, queryFn: getMyAccount, enabled: open });
  const meProfile = meQ.data?.state === 'ok' ? meQ.data : null;
  const myName = meProfile?.name ?? acctQ.data?.name ?? sessionName ?? '';
  const link = profileLink(meId);

  const tastedQ = useQuery({ queryKey: TASTED_WITH_KEY, queryFn: getTastedWith, enabled: open, staleTime: 30_000 });
  useEffect(() => {
    if (open && chips === null && tastedQ.data) setChips(tastedQ.data);
  }, [open, chips, tastedQ.data]);

  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(() => setSearch(q.length >= 2 ? q : ''), 250);
    return () => clearTimeout(t);
  }, [query]);
  const searchQ = useQuery({ queryKey: [...SEARCH_KEY, search], queryFn: () => searchPeople(search), enabled: open && search !== '' });

  // Reset when the sheet closes, so reopening is clean (the scanner hook
  // disarms itself).
  useEffect(() => {
    if (open) return;
    setPane('main');
    setQuery('');
    setSearch('');
    setResult(null);
    setChips(null);
    setDone(new Set());
  }, [open]);

  // ── Scan (D8) ─────────────────────────────────────────────────────────────
  // Subscribed only while open. Disabled on the result pane.
  const { scan, launching } = useVerreScanner(open, (code) => {
    setResult(code);
    setPane('result');
  });

  // ── Writes + pushes ───────────────────────────────────────────────────────
  const follow = (id: number) => {
    setDone((d) => new Set(d).add(id));
    void relate(queryClient, id, 'follow').then(({ ok }) => {
      if (!ok) setDone((d) => {
        const n = new Set(d);
        n.delete(id);
        return n;
      });
    });
  };
  const leaveTo = (push: () => void) =>
    guard(() => {
      onClose();
      push();
    });
  const openProfile = (id: number) => leaveTo(() => router.push(feedHref(mount, 'profile', { id: String(id) })));

  const tastedRows = useMemo(() => {
    const all = chips ?? [];
    const q = query.trim();
    return q ? all.filter((p) => fuzzyIncludes(p.name, q)) : all;
  }, [chips, query]);

  // ── Header (shared) ───────────────────────────────────────────────────────
  const header = (
    // .at-head.yo-af-head — title + Scan, or a back chevron in the panes.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
      {pane !== 'main' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          onPress={() => { setPane('main'); setResult(null); }}
          style={({ pressed }) => ({ marginLeft: -6, width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
        >
          <Icon name="back" size={22} color={theme.ink} />
        </Pressable>
      ) : null}
      <VText variant="subhead" style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>
        Add Friends
      </VText>
      {pane === 'search' ? null : (
        // .yo-af-scan as a filled accent button (ruled 2026-11-12: the outlined
        // pill didn't read as a button): the QR glyph a size up from the
        // label's, and the label just "Scan" (the glyph says QR).
        <Button
          title="Scan"
          icon="qr"
          iconSize={20}
          size="sm"
          accessibilityLabel="Scan a QR Code"
          disabled={pane === 'result' || launching}
          onPress={() => { if (pane !== 'result') void scan(); }}
        />
      )}
    </View>
  );

  const relControl = (p: { id: number; name: string; isFollowing: boolean; followsViewer: boolean }) => <RelControl {...p} onFollow={() => follow(p.id)} />;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      enableDynamicSizing={pane !== 'search'}
      snapPoints={pane === 'search' ? ['85%'] : undefined}
    >
      {pane === 'main' ? (
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 16 }}>
          {header}
          {/* Your code, flat on the sheet: the QR, then you (.yo-af-me; under
              the code since 2026-11-12, the mock has it above), then
              .ish-codelbl. */}
          <View style={{ alignItems: 'center', gap: 12 }}>
            <QrCode value={link} size={168} />
            {/* Photo + name centred as one group, capped at the sheet's width
                so a long name ends in "…" instead of running off both sides. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
              <Avatar imageUrl={meProfile?.imageUrl ?? null} name={myName || '?'} size={26} initialsSize={10} />
              <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold', flexShrink: 1 }} numberOfLines={1}>{myName}</VText>
            </View>
            <VText variant="small" color="inkSoft">Scan to follow me on Verre</VText>
          </View>

          {/* .ish-friends — the tasted-with chips (hidden when there are none
              or they failed to load) + the search field. */}
          <View style={{ gap: 10 }}>
            {chips === null && tastedQ.isPending ? (
              <View style={{ height: 84, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
              </View>
            ) : chips && chips.length > 0 ? (
              <>
                <VText variant="label" color="inkSoft" style={{ letterSpacing: 1.54 }}>PEOPLE YOU TASTED WITH</VText>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingBottom: 4 }}>
                  {chips.map((p) => (
                    <TastedChip key={p.id} person={p} done={done.has(p.id)} onFollow={() => follow(p.id)} />
                  ))}
                </ScrollView>
              </>
            ) : null}
            {/* Pseudo-field (opens the search pane), the invite sheet's. */}
            <Pressable
              accessibilityRole="button"
              onPress={() => setPane('search')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}
            >
              <Icon name="search" size={16} color={theme.inkSoft} />
              <VText variant="small" color="inkFaint">Search people by name</VText>
            </Pressable>
          </View>

          <ShareFooterButton title="Share Profile Link" onPress={() => void shareProfile(myName, meId)} />
        </BottomSheetView>
      ) : pane === 'search' ? (
        // FIXED-height pane (85%) with a BottomSheetScrollView: a plain View
        // wrapper, never BottomSheetView (the sheet-scroll invariant).
        <View style={{ flex: 1, width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 14 }}>
          {header}
          {/* Reached only by tapping the pseudo-field: type at once (ruled 2026-11-12). */}
          <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search people by name" autoFocus />
          <BottomSheetScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
            {search ? (
              <View style={{ marginBottom: 18 }}>
                <SectionLabel>RESULTS</SectionLabel>
                {searchQ.isPending ? (
                  <View style={{ paddingVertical: 16, alignItems: 'center' }}><ActivityIndicator /></View>
                ) : searchQ.isError ? (
                  <VText variant="small" color="inkSoft" style={{ paddingVertical: 12 }}>Couldn’t search. Try again.</VText>
                ) : (searchQ.data ?? []).length === 0 ? (
                  <VText variant="small" color="inkSoft" style={{ paddingVertical: 12 }}>No matches.</VText>
                ) : (
                  searchQ.data!.map((p, i) => (
                    <FriendRow
                      key={p.id}
                      person={p}
                      first={i === 0}
                      subtitle={personLine(p)}
                      onPress={() => openProfile(p.id)}
                      trailing={relControl(p)}
                    />
                  ))
                )}
              </View>
            ) : null}
            {tastedRows.length > 0 ? (
              <View>
                <SectionLabel>PEOPLE YOU TASTED WITH</SectionLabel>
                {tastedRows.map((p, i) => (
                  <FriendRow
                    key={p.id}
                    person={p}
                    first={i === 0}
                    subtitle={lastMomentLine(p.lastMoment.name, p.lastMoment.at)}
                    onPress={() => openProfile(p.id)}
                    trailing={relControl({ id: p.id, name: p.name, isFollowing: done.has(p.id), followsViewer: p.followsViewer })}
                  />
                ))}
              </View>
            ) : null}
          </BottomSheetScrollView>
          <Button title="Done" block onPress={onClose} />
        </View>
      ) : (
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 16 }}>
          {header}
          {result ? <ScanResult result={result} meId={meId} leaveTo={leaveTo} /> : null}
        </BottomSheetView>
      )}
    </Sheet>
  );
}

function SectionLabel({ children }: { children: string }) {
  // .fr-sec
  return <VText variant="label" color="inkSoft" style={{ marginBottom: 4, letterSpacing: 1.54 }}>{children}</VText>;
}

// A quick-add chip: Follow at once; ✓ (inert) once followed.
function TastedChip({ person, done, onFollow }: { person: TastedWith; done: boolean; onFollow: () => void }) {
  return (
    <QuickAddChip
      name={person.name}
      imageUrl={person.imageUrl}
      done={done}
      accessibilityLabel={done ? `Following, ${person.name}` : `${person.followsViewer ? 'Follow Back' : 'Follow'}, ${person.name}`}
      onPress={onFollow}
    />
  );
}

// The relationship control on a sheet row (.fr-in / .fr-btn): Friends /
// Following as a status chip (inert: unfollow lives on People rows and the
// profile), Follow Back / + Follow as the button.
function RelControl({ id, name, isFollowing, followsViewer, onFollow }: { id: number; name: string; isFollowing: boolean; followsViewer: boolean; onFollow: () => void }) {
  const busy = usePersonBusy(id);
  if (isFollowing) return <FriendRowBadge label={followsViewer ? 'Friends' : 'Following'} />;
  return (
    <FriendRowButton
      label={followsViewer ? 'Follow Back' : 'Follow'}
      plus={!followsViewer}
      busy={busy}
      accessibilityLabel={`${followsViewer ? 'Follow Back' : 'Follow'}, ${name}`}
      onPress={onFollow}
    />
  );
}
