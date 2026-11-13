import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DateField, SelectField } from '@/components/moments/momentForm';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { VText } from '@/components/ui/VText';
import { getMyFriends } from '@/lib/api/me';
import type { MomentQuery } from '@/lib/api/sessions';
import { GUTTER, usePhoneTokens } from '@/lib/layout';
import { fuzzyIncludes } from '@/lib/search';
import { useTheme } from '@/theme';

// THE moments filter (lists plan D14): Date / role / Host / Friends There /
// Category, the active chips and the stacked multi-pickers. Moved VERBATIM out
// of Recent moments (app/(tabs)/moments/recents.tsx, on TestFlight: no visible
// or behavioural change there) so every moments list shares it: Recent /
// Upcoming, your Moments and someone's (components/profile/lists/). The facet
// keys map 1:1 to the server params (lib/momentFacets.ts, shared by
// /api/me/sessions and /api/users/:id/moments). On someone's list the role
// facet is THEIR role (the `role` prop names it) and the host options gain
// that person, first after You (`useMomentFilterOptions(owner)`).

export type RoleKey = 'host' | 'cohost' | 'provider' | 'taster';
export const ROLE_OPTIONS: { key: RoleKey; label: string }[] = [
  { key: 'host', label: 'Host' },
  { key: 'cohost', label: 'Co-host' },
  { key: 'provider', label: 'Provider' },
  { key: 'taster', label: 'Taster' },
];

// v1 category is wine-only (the create form is non-interactive on it); NULL
// rows predate the column and are wine too. The picker offers just Wine; the
// server folds NULL → 'wine'.
const CATEGORY_LABELS: Record<string, string> = { wine: 'Wine' };
export const categoryLabel = (code: string) => CATEGORY_LABELS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);

// Multi-select facets: empty array = "any". Roles and hosts OR within the
// facet (a session has ONE of each for you); people is AND — "the moments
// Anna AND Tim were both at" is the find-that-dinner query. People + host
// options are the viewer's FRIENDS (+ "You" for hosts): the server derives
// matches, so the picker only needs candidate ids, not a history scan (a
// non-friend host you shared a moment with is the deferred host-facet — see
// the proposal). Facet keys map 1:1 to the server params.
export type Filters = { roles: RoleKey[]; hosts: string[]; people: string[]; category: string; from: Date | null; to: Date | null };
export const NO_FILTERS: Filters = { roles: [], hosts: [], people: [], category: 'any', from: null, to: null };

// The date filter is a plain "which local day" window, but the server compares
// against a stored INSTANT (timestamptz), so we send the picked local day's
// bounds as UTC instants: the START of the local day for `from`, the END of the
// local day for `to`. Because the moment cards render in device-local time too
// (momentFormat.ts toLocaleDateString), "July 5" here means exactly the July 5
// the user sees — no UTC-boundary off-by-a-day. The Date the picker returns is
// some instant on the chosen day; we re-derive local midnight / end-of-day from
// its local Y-M-D so the time-of-day the user happened to pick doesn't leak in.
export function dayStartISO(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();
}
export function dayEndISO(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
}


// Applied facets (the date window counts once).
export function momentFilterCount(filters: Filters): number {
  return (
    (filters.roles.length > 0 ? 1 : 0) +
    (filters.hosts.length > 0 ? 1 : 0) +
    (filters.people.length > 0 ? 1 : 0) +
    (filters.category !== 'any' ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0)
  );
}

// The filter → the request params (the same on every moments list).
export function toMomentParams(filters: Filters): Pick<MomentQuery, 'roles' | 'hosts' | 'people' | 'category' | 'from' | 'to'> {
  return {
    roles: filters.roles,
    hosts: filters.hosts,
    people: filters.people,
    category: filters.category,
    from: dayStartISO(filters.from),
    to: dayEndISO(filters.to),
  };
}

export type HostOption = { key: string; label: string; imageUrl?: string | null };

// The option lists. `owner` = someone's Moments: that person joins the hosts,
// first after You.
export function useMomentFilterOptions(owner?: HostOption) {
  const friends = useQuery({ queryKey: ['my-friends'], queryFn: getMyFriends, staleTime: 60_000 });
  // Filter-option candidates come from the friend list, NOT the loaded page
  // (paginated — a host/friend on a later page would otherwise vanish from
  // their own option list). The server decides the actual matches; the picker
  // only needs candidate ids. People = all friends (Simon's ruling: no counts,
  // show all — the count was cosmetic and only ever page-accurate). Hosts =
  // "You" + friends (a non-friend host is the deferred host-facet).
  const peopleOptions = useMemo(
    () =>
      (friends.data ?? [])
        .map((f) => ({ key: `u:${f.id}`, label: f.name, imageUrl: f.imageUrl }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [friends.data],
  );
  const hostOptions = useMemo(
    () => [
      { key: 'me', label: 'You' },
      ...(owner ? [owner] : []),
      ...(friends.data ?? [])
        .filter((f) => !owner || `u:${f.id}` !== owner.key)
        .map((f) => ({ key: `u:${f.id}`, label: f.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [friends.data, owner],
  );
  // Friend identity keys for the host picker's Friends chip ("u:<id>").
  const friendKeys = useMemo(() => new Set((friends.data ?? []).map((f) => `u:${f.id}`)), [friends.data]);
  // v1: wine only. NULL folds to wine server-side.
  const categoryOptions = useMemo(() => [{ code: 'wine', label: categoryLabel('wine') }], []);

  return { hostOptions, peopleOptions, friendKeys, categoryOptions };
}

// The applied-filter chips under the tool row (body tap edits that facet, ✕
// clears it; "Clear All" from two).
export function MomentFilterChips({
  filters, onChange, onEdit, hostOptions, peopleOptions,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onEdit: (facet?: 'roles' | 'hosts' | 'people' | null) => void;
  hostOptions: HostOption[];
  peopleOptions: HostOption[];
}) {
  const activeCount = momentFilterCount(filters);
  const setFilters = onChange;
  const openFilter = onEdit;
  return (
    <>
      {activeCount > 0 ? (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: GUTTER, paddingTop: 8 }}>
        {filters.from || filters.to ? (
          <ActiveChip
            label={
              filters.from && filters.to
                ? `${shortDay(filters.from)} – ${shortDay(filters.to)}`
                : filters.from
                  ? `From ${shortDay(filters.from)}`
                  : `Until ${shortDay(filters.to!)}`
            }
            onEdit={() => openFilter()}
            onClear={() => setFilters({ ...filters, from: null, to: null })}
          />
        ) : null}
        {filters.roles.length > 0 ? (
          <ActiveChip
            label={summarize(ROLE_OPTIONS.filter((o) => filters.roles.includes(o.key)).map((o) => o.label))}
            onEdit={() => openFilter('roles')}
            onClear={() => setFilters({ ...filters, roles: [] })}
          />
        ) : null}
        {filters.hosts.length > 0 ? (
          <ActiveChip
            // Fall back to a count when a selected key isn't in the current
            // option list (e.g. a host who's no longer a friend) — never a
            // blank pill the user can't read but can still clear.
            label={summarize(hostOptions.filter((o) => filters.hosts.includes(o.key)).map((o) => o.label)) || `${filters.hosts.length} selected`}
            onEdit={() => openFilter('hosts')}
            onClear={() => setFilters({ ...filters, hosts: [] })}
          />
        ) : null}
        {filters.people.length > 0 ? (
          <ActiveChip
            label={summarize(peopleOptions.filter((o) => filters.people.includes(o.key)).map((o) => o.label)) || `${filters.people.length} selected`}
            onEdit={() => openFilter('people')}
            onClear={() => setFilters({ ...filters, people: [] })}
          />
        ) : null}
        {filters.category !== 'any' ? (
          <ActiveChip label={categoryLabel(filters.category)} onEdit={() => openFilter()} onClear={() => setFilters({ ...filters, category: 'any' })} />
        ) : null}
        {activeCount > 1 ? (
          <Pressable accessibilityRole="button" onPress={() => setFilters(NO_FILTERS)} hitSlop={6} style={({ pressed }) => ({ justifyContent: 'center', paddingHorizontal: 6, opacity: pressed ? 0.5 : 1 })}>
            <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Clear All</VText>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    </>
  );
}

// ── filter sheet — Date / Your role / Host / People / Category ──────────────
// Role, host and people are MULTI-select dropdowns (Simon's spec: "like the
// impression type"): a SelectField row summarising the picks opens a stacked
// check-list picker sheet (Sheet stackBehavior='push' returns here on close).

// Short day label for the active-date chip ("12 Jun").
const shortDay = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// .active-chip — one applied filter. Body tap EDITS (reopens the filter on
// that facet); only the ✕ removes (Simon's ruling — the inner Pressable wins
// the touch, same nesting pattern as the line-up row pills).
export function ActiveChip({ label, onEdit, onClear }: { label: string; onEdit: () => void; onClear: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit filter ${label}`}
      onPress={onEdit}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 28, paddingLeft: 11,
        borderRadius: 999, borderWidth: 1, borderColor: theme.accentLine, backgroundColor: theme.accentTint,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>
        {label}
      </VText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove filter ${label}`}
        onPress={onClear}
        hitSlop={{ top: 8, bottom: 8, left: 2, right: 4 }}
        style={({ pressed }) => ({ paddingHorizontal: 8, alignSelf: 'stretch', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="x" size={12} color={theme.accent} />
      </Pressable>
    </Pressable>
  );
}

// Empty → '' so SelectField shows its placeholder ("Any role" / "Anyone").
export function summarize(labels: string[]): string {
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

// The filter sheets' shared pieces (Filter Moments, Filter Impressions): a
// choice chip, the uppercase section label, the From / To day pair, and the
// Reset | Done footer.
export function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        minHeight: 32, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1,
        borderColor: on ? theme.accentLine : theme.rule,
        backgroundColor: on ? theme.accentTint : theme.surface,
        alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText variant="small" style={{ fontFamily: on ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium' }} color={on ? 'accent' : 'ink'}>
        {label}
      </VText>
    </Pressable>
  );
}

export function FilterLabel({ children }: { children: string }) {
  return <VText variant="label" color="inkSoft" style={{ letterSpacing: 1.54 }}>{children}</VText>;
}

// Whole days (the shown date, else created, like the list order).
export function FilterDates({ from, to, onChange }: { from: Date | null; to: Date | null; onChange: (from: Date | null, to: Date | null) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <DateField label="From" mode="date" value={from} onChange={(d) => onChange(d, to)} defaultValue={() => new Date()} maximumDate={to ?? undefined} />
      <DateField label="To" mode="date" value={to} onChange={(d) => onChange(from, d)} defaultValue={() => new Date()} minimumDate={from ?? undefined} />
    </View>
  );
}

export function FilterFooter({ onReset, onDone }: { onReset: () => void; onDone: () => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
      <Button title="Reset" variant="secondary" block style={{ flex: 1 }} onPress={onReset} />
      <Button title="Done" block style={{ flex: 1 }} onPress={onDone} />
    </View>
  );
}

export function MomentFilterSheet({
  open, onClose, filters, onChange, hostOptions, peopleOptions, categoryOptions, friendKeys, initialPicker,
  role = { title: 'Your Role', a11y: 'Filter by your role' },
}: {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  onChange: (f: Filters) => void;
  hostOptions: { key: string; label: string }[];
  peopleOptions: { key: string; label: string; imageUrl: string | null }[];
  categoryOptions: { code: string; label: string }[];
  friendKeys: Set<string>;
  /** Facet picker to open immediately (active-chip edit path). */
  initialPicker: 'roles' | 'hosts' | 'people' | null;
  /** Whose role the role facet reads (yours by default; theirs on someone's list). */
  role?: { title: string; a11y: string };
}) {
  const insets = useSafeAreaInsets();
  const [picker, setPicker] = useState<'roles' | 'hosts' | 'people' | null>(null);
  // Jump straight to the tapped facet's picker when opened from an active
  // chip (both sheets present this tick — parent mounts first, child stacks).
  useEffect(() => {
    if (open) setPicker(initialPicker);
  }, [open, initialPicker]);
  const roleLabels = ROLE_OPTIONS.filter((o) => filters.roles.includes(o.key)).map((o) => o.label);
  const hostLabels = hostOptions.filter((o) => filters.hosts.includes(o.key)).map((o) => o.label);
  const peopleLabels = peopleOptions.filter((o) => filters.people.includes(o.key)).map((o) => o.label);
  const chip = (k: string, label: string, on: boolean, onPress: () => void) => <FilterChip key={k} label={label} on={on} onPress={onPress} />;
  const section = (label: string) => <FilterLabel>{label}</FilterLabel>;
  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 16, gap: 18 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Filter Moments</VText>
          <View style={{ gap: 10 }}>
            {section('DATE')}
            {/* Whole days — the moment's shown date (or its created date when no
                date is set, matching the list order). */}
            <FilterDates from={filters.from} to={filters.to} onChange={(from, to) => onChange({ ...filters, from, to })} />
          </View>
          <View style={{ gap: 10 }}>
            {section(role.title.toUpperCase())}
            <SelectField value={summarize(roleLabels)} placeholder="Any role" onPress={() => setPicker('roles')} accessibilityLabel={role.a11y} />
          </View>
          <View style={{ gap: 10 }}>
            {section('HOST')}
            <SelectField value={summarize(hostLabels)} placeholder="Anyone" onPress={() => setPicker('hosts')} accessibilityLabel="Filter by host" />
          </View>
          {/* Friends only — anon guests aren't stable identities across
              moments and don't survive expiry; hidden with no friends. */}
          {peopleOptions.length > 0 ? (
            <View style={{ gap: 10 }}>
              {section('FRIENDS THERE')}
              <SelectField value={summarize(peopleLabels)} placeholder="Anyone" onPress={() => setPicker('people')} accessibilityLabel="Filter by friends who were part of the moment" />
            </View>
          ) : null}
          <View style={{ gap: 10 }}>
            {section('CATEGORY')}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {chip('any', 'Any', filters.category === 'any', () => onChange({ ...filters, category: 'any' }))}
              {categoryOptions.map((c) => chip(c.code, c.label, filters.category === c.code, () => onChange({ ...filters, category: c.code })))}
            </View>
          </View>
          <FilterFooter onReset={() => onChange(NO_FILTERS)} onDone={onClose} />
        </BottomSheetView>
      </Sheet>
      <MultiPickSheet
        open={picker === 'roles'}
        onClose={() => setPicker(null)}
        title={role.title}
        options={ROLE_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        selected={filters.roles}
        onClear={() => onChange({ ...filters, roles: [] })}
        onToggle={(k) =>
          onChange({ ...filters, roles: filters.roles.includes(k as RoleKey) ? filters.roles.filter((x) => x !== k) : [...filters.roles, k as RoleKey] })
        }
      />
      <MultiPickSheet
        open={picker === 'hosts'}
        onClose={() => setPicker(null)}
        title="Host"
        options={hostOptions}
        selected={filters.hosts}
        withAvatars
        search
        friendKeys={friendKeys}
        onClear={() => onChange({ ...filters, hosts: [] })}
        onToggle={(k) => onChange({ ...filters, hosts: filters.hosts.includes(k) ? filters.hosts.filter((x) => x !== k) : [...filters.hosts, k] })}
      />
      <MultiPickSheet
        open={picker === 'people'}
        onClose={() => setPicker(null)}
        title="Friends There"
        options={peopleOptions}
        selected={filters.people}
        withAvatars
        search
        onClear={() => onChange({ ...filters, people: [] })}
        onToggle={(k) => onChange({ ...filters, people: filters.people.includes(k) ? filters.people.filter((x) => x !== k) : [...filters.people, k] })}
      />
    </>
  );
}

// ── stacked multi-select picker (compare people-picker pattern: rows + round
// checks; search over long lists; pinned Clear|Apply footer). Sizing is the
// cap-aware recipe (ComparePickerSheet): CONTENT-SIZED while the estimate fits
// (dynamic sizing — but that mode can't scroll, rows past the cap would clip
// unreachably), else a snap sized to the CONTENT estimate capped at 85%, with
// rows in a BottomSheetScrollView. A searchable list always takes the snap
// mode so the sheet doesn't resize under every keystroke. layer=1: the pushed
// sheet's backdrop must dim the filter sheet BELOW it (see Sheet's layer doc).

export function MultiPickSheet({
  open, onClose, title, options, selected, onToggle, onClear, withAvatars, search, friendKeys,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: { key: string; label: string; anon?: boolean; imageUrl?: string | null; caption?: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
  withAvatars?: boolean;
  /** Force the search row on (default: auto — lists past 7 rows get one). */
  search?: boolean;
  /** Enables the Friends chip beside the search row (host picker): narrows the
   *  options to keys in this set. Chip renders only when a friend is listed. */
  friendKeys?: Set<string>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const { height: windowH, fontScale } = useWindowDimensions();
  const [q, setQ] = useState('');
  const [friendsOnly, setFriendsOnly] = useState(false);
  const hasFriendOption = !!friendKeys && options.some((o) => friendKeys.has(o.key));
  const rows = options
    .filter((o) => !friendsOnly || !friendKeys || friendKeys.has(o.key))
    .filter((o) => !q.trim() || fuzzyIncludes(o.label, q));
  const searchable = search || options.length > 7;
  // Row = paddingVertical (comfort-scaled) ×2 + the taller of the text line
  // and the comfort-grown avatar; chrome = handle/title/paddings + the pinned
  // footer. The row's padding + avatar GROW on big phones (phone.lerp/grow),
  // so the estimate must feed the SAME grown values in — a flat estimate would
  // under-count and keep a near-cap roster in dynamic-fit mode where its bottom
  // rows clip unreachably (reviewer catch).
  const rowH = Math.max(phone.grow(30), Math.ceil((phone.text('body').lineHeight ?? 22) * fontScale)) + phone.lerp(10, 13) * 2 + 1;
  const chrome = 92 + (searchable ? 48 : 0) + 78 + insets.bottom;
  const estimate = chrome + options.length * rowH;
  const needsSnap = searchable || estimate > windowH * 0.85;
  // BottomSheetView only in fit-to-content mode; in snap/scroll mode a plain
  // View — BottomSheetView around the scrollable re-registers the sheet's
  // scrollable as type VIEW and locks the list (apps/mobile/CLAUDE.md
  // sheet-scroll invariant).
  const Wrap = needsSnap ? View : BottomSheetView;
  const footer = (
    <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 12, borderTopWidth: 1, borderTopColor: theme.rule }}>
      <Button title="Clear" variant="secondary" block style={{ flex: 1 }} disabled={selected.length === 0} onPress={onClear} />
      <Button
        title={selected.length > 0 ? `Apply (${selected.length})` : 'Apply'}
        block
        style={{ flex: 1 }}
        onPress={() => { setQ(''); setFriendsOnly(false); onClose(); }}
      />
    </View>
  );
  const head = (
    <View style={{ paddingHorizontal: 20, gap: 12 }}>
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
      {searchable ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <SheetSearchField value={q} onChangeText={setQ} placeholder={`Search ${title.toLowerCase()}`} />
          </View>
          {hasFriendOption ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: friendsOnly }}
              accessibilityLabel={friendsOnly ? 'Show everyone' : 'Show friends only'}
              hitSlop={{ top: 5, bottom: 5 }}
              onPress={() => setFriendsOnly((f) => !f)}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34,
                paddingHorizontal: 11, borderRadius: 999, borderWidth: 1,
                borderColor: friendsOnly ? theme.accentLine : theme.rule,
                backgroundColor: friendsOnly ? theme.accentTint : theme.surface,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Icon name="users" size={14} color={friendsOnly ? theme.accent : theme.inkSoft} />
              <VText surface="badge" variant="small" color={friendsOnly ? 'accent' : 'inkSoft'} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                Friends
              </VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  const renderRow = (o: (typeof options)[number], i: number) => {
    const on = selected.includes(o.key);
    return (
      <Pressable
        key={o.key}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${on ? 'Remove' : 'Add'} ${o.label}`}
        onPress={() => onToggle(o.key)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16), paddingVertical: phone.lerp(10, 13),
          borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {withAvatars ? <Avatar imageUrl={o.imageUrl ?? null} name={o.label} size={phone.grow(30)} anon={o.anon} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <VText
            variant="body"
            numberOfLines={1}
            color={o.anon ? 'inkSoft' : 'ink'}
            style={{ fontFamily: o.anon ? 'InstrumentSans_400Regular' : 'InstrumentSans_500Medium' }}
          >
            {o.label}
          </VText>
          {o.caption ? (
            <VText variant="caption" color="inkSoft" numberOfLines={1}>{o.caption}</VText>
          ) : null}
        </View>
        <View
          style={{
            width: 22, height: 22, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
            borderWidth: on ? 0 : 1.5, borderColor: theme.rule,
            backgroundColor: on ? theme.accent : 'transparent',
          }}
        >
          {on ? <Icon name="check" size={13} color={theme.accentInk} /> : null}
        </View>
      </Pressable>
    );
  };
  const empty = <VText variant="small" color="inkSoft" style={{ paddingVertical: 12 }}>No matches.</VText>;
  return (
    <Sheet
      open={open}
      onClose={() => { setQ(''); setFriendsOnly(false); onClose(); }}
      stackBehavior="push"
      layer={1}
      {...(needsSnap ? { snapPoints: [Math.min(estimate, windowH * 0.85)], enableDynamicSizing: false } : { maxDynamicContentSize: windowH * 0.85 })}
    >
      <Wrap style={needsSnap ? { flex: 1, paddingTop: 12 } : { width: '100%', paddingTop: 12 }}>
        {head}
        {needsSnap ? (
          <BottomSheetScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
            {rows.length === 0 ? empty : rows.map(renderRow)}
          </BottomSheetScrollView>
        ) : (
          <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
            {rows.length === 0 ? empty : rows.map(renderRow)}
          </View>
        )}
        {footer}
      </Wrap>
    </Sheet>
  );
}

