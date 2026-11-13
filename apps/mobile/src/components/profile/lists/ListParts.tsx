import { useCallback, useRef, type ReactNode } from 'react';
import { Pressable, View, type ViewInstance } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { Thumb } from '@/components/ui/Thumb';
import { VText } from '@/components/ui/VText';
import { StarScore } from '@/components/scoring/StarScore';
import { formatScore } from '@verre/core';
import { DATE_LOCALE } from '@/lib/locale';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

// Shared anatomy of the profile tile lists (design 04·6 / 04·9 / 04·10,
// vero-you.css `.yo-toolrow`, `.yo-month`, `.yo-right`, `.yo-you`). The round
// tool button is `ui/ToolButton.tsx`.

// .yo-toolrow: the round button(s) + the search pill.
export function ToolRow({ children, query, onQuery, placeholder }: { children?: ReactNode; query: string; onQuery: (q: string) => void; placeholder: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
      {children}
      <View style={{ flex: 1 }}>
        <SheetSearchField value={query} onChangeText={onQuery} placeholder={placeholder} />
      </View>
    </View>
  );
}

// .yo-month: device-local month, the year added when it isn't this year.
export function monthLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.toLocaleDateString(DATE_LOCALE, { month: 'long' });
  return d.getFullYear() === new Date().getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

// Rows interleaved with month headers over the FLATTENED pages, so a page
// break never repeats a header.
export type Grouped<T> = { kind: 'month'; key: string; label: string; first: boolean } | { kind: 'row'; key: string; row: T };
export function groupByMonth<T>(rows: T[], when: (r: T) => string | null, key: (r: T) => string): Grouped<T>[] {
  const out: Grouped<T>[] = [];
  let last: string | null = null;
  for (const r of rows) {
    const iso = when(r);
    const label = iso ? monthLabel(iso) : '';
    if (label && label !== last) {
      out.push({ kind: 'month', key: `m:${label}:${out.length}`, label, first: last === null });
      last = label;
    }
    out.push({ kind: 'row', key: key(r), row: r });
  }
  return out;
}

export function MonthHeader({ label, first }: { label: string; first: boolean }) {
  return (
    <VText variant="label" color="inkSoft" style={{ letterSpacing: 1.54, paddingTop: first ? 2 : 16, paddingBottom: 4 }}>
      {label.toUpperCase()}
    </VText>
  );
}

// .sh-row on the house list-row anatomy (RecentRow / PeopleRow: Thumb grown
// by comfort, gap + padding lerped): thumb · name (+ vintage in ink-soft) ·
// meta · the right column (`.yo-right`). No chevron (the mock's impressions /
// cravings rows have none); moments pass `chevron`.
// What a tapped row hands its caller for the 'row' transition (an opened post
// grows out of it): `measure` = its window frame, read when asked (null when
// the row is gone; the caller measures at the moment it needs it, after any
// await, never at tap time); `face` = a static copy of the row (no press, hidden
// from VoiceOver), drawn on the growing container while it fades out.
export type RowFrame = { x: number; y: number; width: number; height: number };
export type RowHandle = { measure: () => Promise<RowFrame | null>; face: ReactNode };

export function ListRow({
  uri, title, vintage, meta, right, below, chevron, onPress, accessibilityLabel, transparent,
}: {
  uri: string | null;
  title: string;
  vintage?: string | null;
  meta?: string | null;
  right?: ReactNode;
  below?: ReactNode;
  chevron?: boolean;
  onPress?: (row: RowHandle) => void;
  accessibilityLabel?: string;
  // The face only: no row background, so the container's tone shows through.
  transparent?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  const ref = useRef<ViewInstance>(null);
  // A belt on the callback: a row that unmounted (a refresh, a removal) never
  // answers, so the frame falls back to null after a beat.
  const measure = useCallback<RowHandle['measure']>(() => new Promise((resolve) => {
    const node = ref.current;
    if (!node) return resolve(null);
    const t = setTimeout(() => resolve(null), 120);
    node.measureInWindow((x, y, width, height) => {
      clearTimeout(t);
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  }), []);
  return (
    <Pressable
      ref={ref}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      disabled={!onPress}
      onPress={onPress ? () => onPress({
        measure,
        face: (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ListRow uri={uri} title={title} vintage={vintage} meta={meta} right={right} below={below} chevron={chevron} transparent />
          </View>
        ),
      }) : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: phone.lerp(12, 16),
        paddingVertical: surface.paddingY(phone.lerp(10, 16)),
        backgroundColor: transparent ? 'transparent' : theme.bg,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Thumb uri={uri} size={phone.size('recentThumb')} />
      <View style={{ flex: 1, minWidth: 0, gap: surface.gap(phone.lerp(2, 4)) }}>
        <VText surface="compactList" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {title}
          {vintage ? <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{` ${vintage}`}</VText> : null}
        </VText>
        {meta ? (
          <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>
            {meta}
          </VText>
        ) : null}
        {below}
      </View>
      {right ? <View style={{ alignItems: 'flex-end', gap: 4 }}>{right}</View> : null}
      {chevron ? <Icon name="chevron-right" size={phone.size('recentChevron')} color={theme.inkFaint} /> : null}
    </Pressable>
  );
}

// .yo-right: their score, and (someone else's list) "You ★ 4.25" under it.
export function ScoreColumn({ score, yours }: { score: number | null; yours?: number | null }) {
  const { theme } = useTheme();
  return (
    <>
      {score ? <StarScore value={score} /> : null}
      {yours ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }} accessible accessibilityLabel={`You ${formatScore(yours)}`}>
          <VText variant="caption" color="inkSoft">You</VText>
          <Icon name="starf" size={11} color={theme.accent} />
          <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{formatScore(yours)}</VText>
        </View>
      ) : null}
    </>
  );
}

// The empty / no-match line (`.yo-empty`).
export function ListNote({ children }: { children: ReactNode }) {
  return (
    <VText variant="small" color="inkSoft" style={{ paddingVertical: 28, textAlign: 'center' }}>
      {children}
    </VText>
  );
}
