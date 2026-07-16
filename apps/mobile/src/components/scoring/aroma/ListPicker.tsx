import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { AROMA_FAMILIES } from '@verre/core';
import { Segmented } from '@/components/ui/Segmented';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, alpha, inkOn, readableSolid, readableBorder } from '@/theme/color';
import { radius, useTheme } from '@/theme';
import { usePhoneTokens } from '@/lib/layout';
import { AromaCrumbs, capFirst } from './parts';
import { aromaFillRatio } from './aromaTint';

// L · drill list — the fifth browse picker (Simon's device ask, round 3): a
// plain vertical list you ENTER by tapping — families → groups → notes.
// THREE looks behind the small switcher (device comparison, one survives):
// - "Tinted": every row on its family's tint with a rule border (separated
//   buttons — Simon), words via readableSolid (the badge anatomy); armed row
//   goes solid family colour with a contrast-picked label.
// - "Plain": the People-sheet anatomy — transparent rows, ink words,
//   hairline separators; family colour stays as the leading dot/mark and
//   the armed row's tint.
// - "Cards": the settings SURFACE language (rule border + surface + comfort
//   padding) but each row a SEPARATE button with gaps, like Tinted (Simon,
//   round 2 of the look pass — one shared card was too monolithic).
// The colour accents (leaf dot, round mark ring) are 100% SOLID family
// colour on the non-tinted looks (Simon's ruling; Tinted keeps the softer
// ring — its rows are already colour-saturated).
// A note tap ARMS the pick; the round mark on a family/group row arms the
// WHOLE node (any-tier). The pend state lives in the BROWSE SHEET, which
// pins the refine row to the sheet's bottom (device round 5).

type Look = 'tinted' | 'plain' | 'cards';
const LOOKS: { key: Look; label: string }[] = [
  { key: 'tinted', label: 'Tinted' },
  { key: 'plain', label: 'Plain' },
  { key: 'cards', label: 'Cards' },
];

export function ListPicker({
  pend,
  onPend,
  pendP,
}: {
  pend: string | null;
  onPend: (id: string | null) => void;
  /** The sheet footer's pending-Pronounced — draws the armed row's border. */
  pendP: boolean;
}) {
  const { theme, themeKey } = useTheme();
  const phone = usePhoneTokens();
  const familyColor = useAromaColors();
  // Drill path of node ids: [] = families, [familyId], [familyId, groupId].
  const [path, setPath] = useState<string[]>([]);
  const [look, setLook] = useState<Look>('tinted');
  const tinted = look === 'tinted';

  const family = path[0] ? AROMA_FAMILIES.find((f) => f.id === path[0]) : undefined;
  const group = path[1] && family ? family.subfamilies.find((s) => s.id === path[1]) : undefined;
  const rows: { id: string; label: string; familyId: string; drill: boolean }[] = group
    ? group.leaves.map((l) => ({ id: l.id, label: l.label, familyId: family!.id, drill: false }))
    : family
      ? family.subfamilies.map((s) => ({ id: s.id, label: s.label, familyId: family.id, drill: true }))
      : AROMA_FAMILIES.map((f) => ({ id: f.id, label: f.label, familyId: f.id, drill: true }));

  const popTo = (depth: number) => {
    setPath(path.slice(0, depth));
    onPend(null);
  };

  const cards = look === 'cards';
  const body = rows.map((row, i) => {
    const color = familyColor(row.familyId);
    const armed = pend === row.id;
    // Tinted: badge anatomy — tint fill + solid family-colour words; armed =
    // SOLID family fill + contrast-picked label (inkOn). Plain/Cards: usual
    // rows — ink words; armed = family tint + ink.
    const restingR = aromaFillRatio(themeKey, row.familyId, 0.13);
    // Plain/Cards armed fill (ratio 0.2) can resolve SOLID on a 'solid'
    // per-family bump — track it so the armed pendP border takes the label
    // ink rather than readableBorder (which floors ~1.9:1 on a same-colour
    // solid fill; review finding).
    const plainArmedR = aromaFillRatio(themeKey, row.familyId, 0.2);
    const plainSolid = !tinted && armed && plainArmedR >= 1;
    const fill = tinted
      ? armed || restingR >= 1
        ? color
        : mix(color, theme.surface, restingR)
      : armed
        ? plainArmedR >= 1
          ? color
          : mix(color, theme.surface, plainArmedR)
        : cards
          ? theme.surface
          : 'transparent';
    // Tinted words: readableSolid (Simon's gallery ruling) — solid palette
    // colour where it clears 3:1 on the fill; armed/solid fills take the
    // contrast-picked label. Plain/Cards stay ink.
    const words = tinted
      ? armed || restingR >= 1
        ? inkOn(color, theme.ink, theme.bg)
        : readableSolid(color, theme.ink, fill)
      : plainSolid
        ? inkOn(color, theme.ink, theme.bg) // a 'solid' armed plain/cards fill needs a contrast label
        : theme.ink;
    // Press feedback in the FAMILY colour, not the theme sunk tone (Simon).
    const pressFill = mix(color, theme.surface, aromaFillRatio(themeKey, row.familyId, 0.13));
    // A tinted row whose fill IS the solid colour (armed, or a 'solid'
    // per-family bump) draws its dot/ring in the label ink — same-colour
    // marks would vanish.
    const onSolidT = tinted && (armed || restingR >= 1);
    // Dots + circles wear the READABLE accent (Simon): the words colour on
    // Tinted; on Plain/Cards the readableSolid family colour against the
    // ground the mark actually sits on.
    const mark = tinted ? words : readableSolid(color, theme.ink, armed ? fill : theme.surface);
    return (
      <View key={row.id}>
        {/* hairline separator between rows — the People-sheet rule
            (borderTop-on-row would collide with the pendP border) */}
        {look === 'plain' && i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${capFirst(row.label)}${row.drill ? ', open' : ''}${armed && pendP ? ', pronounced' : ''}`}
          accessibilityState={{ selected: armed }}
          onPress={() => {
            if (row.drill) {
              setPath([...path, row.id]);
              onPend(null);
            } else {
              onPend(pend === row.id ? null : row.id);
            }
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: tinted ? 11 : phone.lerp(cards ? 13 : 12, cards ? 17 : 15),
            paddingHorizontal: cards ? 14 : 12,
            borderRadius: cards ? radius.md : tinted ? 12 : 0,
            // Cards AND Tinted carry the settings' rule border (each row a
            // separated button — Simon); the Pronounced pending flag
            // overrides it with the full family colour (on the armed SOLID
            // tinted fill, the label ink — a same-colour border would
            // vanish). Plain rows keep a transparent border for stability.
            borderWidth: armed && pendP ? 1.5 : cards || tinted ? 1 : 1.5,
            borderColor: armed && pendP ? (tinted ? words : plainSolid ? inkOn(color, theme.ink, theme.bg) : readableBorder(color, theme.ink, fill)) : cards || tinted ? theme.rule : 'transparent',
            backgroundColor: pressed && !armed && !tinted ? pressFill : fill,
          })}
        >
          {row.drill ? (
            // The round mark — arms the WHOLE family/group (any-tier), while
            // the row itself drills. Child Pressable claims the touch (the
            // 02b nested-pressable pattern). hitSlop grows the mark to the
            // row's full height + the leading padding (RN clips slop to the
            // PARENT frame).
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: armed }}
              accessibilityLabel={`Pick all of ${row.label}`}
              onPress={() => onPend(pend === row.id ? null : row.id)}
              hitSlop={{ top: 11, bottom: 11, left: 12, right: 8 }}
            >
              {armed ? (
                <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: mark }} />
              ) : (
                // Solid readable ring on Plain/Cards; Tinted keeps the softer
                // alpha ring on its saturated rows.
                <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: tinted ? alpha(mark, onSolidT ? 0.7 : 0.55) : mark }} />
              )}
            </Pressable>
          ) : (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: mark, marginHorizontal: 5 }} />
          )}
          <VText
            variant="body"
            surface={tinted ? 'badge' : undefined}
            style={
              tinted
                ? { flex: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 14, color: words }
                : { flex: 1, fontFamily: 'InstrumentSans_500Medium', color: words }
            }
          >
            {capFirst(row.label)}
          </VText>
          {row.drill ? <Icon name="chevron-right" size={15} color={tinted ? words : theme.inkSoft} /> : null}
        </Pressable>
      </View>
    );
  });

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <AromaCrumbs path={path} onPop={popTo} />
        </View>
        {/* look switcher — mini twin of the sheet's variant control */}
        <Segmented compact segments={LOOKS} active={look} onSelect={setLook} style={{ marginBottom: 8 }} />
      </View>
      <View style={{ gap: cards ? 8 : tinted ? 6 : 0 }}>{body}</View>
    </View>
  );
}
