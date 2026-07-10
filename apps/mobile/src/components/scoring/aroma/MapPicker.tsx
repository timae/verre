import { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { AROMA_FAMILIES } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { useAromaColors } from '@/theme/flavourColors';
import { mix } from '@/theme/color';
import { useTheme } from '@/theme';
import { CapHint, RefineAddRow, capFirst, usePendingAdd, type AromaOps } from './parts';
import { HexStage, type HexCell } from './hexStage';
import { LEVEL_R, placeLevel, type MapLevel as Level, type Placed } from './mapLayout';

// H3 · zoomable map — one of the four device-test browse pickers (ADR-0008;
// mock: mapInner in vero-aroma-input.js, visual reference only). The whole
// taxonomy as one honeycomb "map": level 1 shows the 12 families as
// continents; tapping zooms to level 2 — EVERY group placed on one lattice,
// clustered around its family's centroid — then level 3, every note,
// clustered by family and shaded by group. Drag roams the map (clamped pan);
// Zoom out steps back up. At the note level a tap arms the pick; the add bar
// below commits it — and because the bar's target falls back to the node you
// ZOOMED INTO, a whole group or family is addable without picking a note
// (the any-tier ruling).

const STAGE_H = 300;
const TIERS: Record<Level, string> = { 1: 'Families', 2: 'Groups', 3: 'Notes' };

export function MapPicker({ ops }: { ops: AromaOps }) {
  const { theme } = useTheme();
  const familyColor = useAromaColors();
  const [level, setLevel] = useState<Level>(1);
  // The node whose cluster the stage centres on (a family at level 2, a
  // group at level 3) — also the refine row's any-tier fallback target.
  const [focus, setFocus] = useState<string | null>(null);
  const [pend, setPend] = useState<string | null>(null);
  // Travel direction of the last level change — the stage's settle-in
  // starts smaller (diving in) or larger (pulling out) to match.
  const [enterFrom, setEnterFrom] = useState(0.8);
  const target = pend ?? (level > 1 ? focus : null);
  const pendState = usePendingAdd(target, ops);

  const placed = useMemo(() => placeLevel(level), [level]);
  const cells: HexCell[] = useMemo(
    () =>
      placed.map((p) => ({
        id: p.id,
        label: p.label,
        color: p.shade ? mix(familyColor(p.familyId), theme.ink, p.shade) : familyColor(p.familyId),
        x: p.x,
        y: p.y,
        pending: pend === p.id,
        muted: !!pend && pend !== p.id,
        pronounced: pend === p.id && pendState.pendP,
      })),
    [placed, familyColor, theme.ink, pend, pendState.pendP],
  );

  // Centre on the focused cluster (the cells that came from the node we
  // zoomed into), else the map centre.
  const center = useMemo(() => {
    const inFocus = placed.filter((p) => (level === 2 ? p.familyId === focus : level === 3 ? p.groupId === focus : false));
    if (!inFocus.length) return { x: 0, y: 0 };
    return {
      x: inFocus.reduce((a, p) => a + p.x, 0) / inFocus.length,
      y: inFocus.reduce((a, p) => a + p.y, 0) / inFocus.length,
    };
  }, [placed, level, focus]);

  const onCell = (id: string) => {
    if (level < 3) {
      setFocus(id);
      setLevel((level + 1) as Level);
      setPend(null);
      setEnterFrom(0.8);
      return;
    }
    setPend((p) => (p === id ? null : id));
  };

  // Pinch-between-levels (device ask): pinch IN zooms toward the cluster
  // under the fingers — the nearest placed cell picks the focus node — and
  // pinch OUT steps back up. Taps still work; both share the level state.
  // A pinch commit lands mid-zoom, so its settle-in starts much closer to 1
  // than a tap's (0.92/1.08 vs 0.8/1.18) — the full tap dive stacked on the
  // live pinch scale read as a jump-back (device round, "jumpy").
  const onPinchLevel = (dir: 1 | -1, cx: number, cy: number) => {
    if (dir < 0) {
      zoomOut(1.08);
      return;
    }
    if (level >= 3) return;
    let best: Placed | null = null;
    let bd = Infinity;
    for (const p of placed) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) return;
    setFocus(best.id); // level 1 cell = a family, level 2 cell = a group
    setLevel((level + 1) as Level);
    setPend(null);
    setEnterFrom(0.92);
  };

  const zoomOut = (from = 1.18) => {
    if (level === 1) return;
    // Parent of the current focus: a group's family at level 3, none above a
    // family.
    const parent =
      level === 3 && focus ? AROMA_FAMILIES.find((f) => f.subfamilies.some((s) => s.id === focus))?.id ?? null : null;
    setFocus(parent);
    setLevel((level - 1) as Level);
    setPend(null);
    setEnterFrom(from);
  };

  return (
    <View style={{ gap: 10 }}>
      {/* level bar: zoom out + tier dots + tier words */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 26 }}>
        {level > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom Out"
            onPress={() => zoomOut()}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 3,
              paddingVertical: 6,
              paddingLeft: 7,
              paddingRight: 11,
              borderRadius: 999,
              backgroundColor: theme.accentTint,
            }}
          >
            <Icon name="back" size={14} color={theme.accent} />
            <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.accent }}>
              Zoom Out
            </VText>
          </Pressable>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {([1, 2, 3] as const).map((k) => (
            <View
              key={k}
              style={{
                width: k === level ? 14 : 5,
                height: 5,
                borderRadius: 999,
                backgroundColor: k === level ? theme.accent : theme.rule,
              }}
            />
          ))}
        </View>
        {/* Just the tier word — the "continents/countries · drag to roam"
            tail was cut on device review (2026-07-10). numberOfLines keeps
            the row height stable under grown Dynamic Type. */}
        <VText surface="badge" numberOfLines={1} style={{ flexShrink: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, color: theme.ink }}>
          {TIERS[level]}
        </VText>
      </View>
      {/* the map — full-bleed past the sheet gutter so roaming has room */}
      <View style={{ marginHorizontal: -20 }}>
        <HexStage
          cells={cells}
          R={LEVEL_R[level]}
          stageH={STAGE_H}
          center={center}
          onCell={onCell}
          resetKey={`${level}:${focus ?? ''}`}
          capFirst={capFirst}
          onPinchLevel={onPinchLevel}
          canZoomIn={level < 3}
          canZoomOut={level > 1}
          enterFrom={enterFrom}
        />
      </View>
      {/* the search refine row — armed by a note tap (or the zoomed-into
          node, any-tier); its pending Pronounced draws the cell border. */}
      <RefineAddRow
        a={target}
        m={pendState.pendM}
        p={pendState.pendP}
        added={pendState.added}
        onM={pendState.setPendM}
        onP={pendState.togglePendP}
        onAdd={() => {
          if (pendState.commit()) setPend(null);
        }}
      />
      <CapHint show={pendState.capHit} />
    </View>
  );
}
