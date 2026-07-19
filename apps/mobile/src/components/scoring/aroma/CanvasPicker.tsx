import { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { AROMA_FAMILIES } from '@verre/core';
import { useAromaColors } from '@/theme/flavourColors';
import { AromaCrumbs, CapHint, RefineAddRow, capFirst, usePendingAdd, type AromaOps } from './parts';
import { HexStage, STAGE_PAD, type HexCell } from './hexStage';
import { honeyXY } from './hexMath';
import { LEVEL_R, type MapLevel } from './mapLayout';

// H2 · zoom canvas — one of the browse picker variants (ADR-0008; mock:
// honeyInner('H2') in vero-aroma-input.js, visual reference only). A dive
// INTO one family's colour space: the root shows the twelve families as a
// compact comb, tapping one replaces the cluster with its groups — every
// cell strictly on the family's colour — then its notes. Drag pans when a
// cluster outgrows the stage. A note tap arms the pick (search-focus
// treatment); the refine row's target falls back to the level you dove
// into, so a whole family or group is addable mid-dive (the any-tier
// ruling). Breadcrumb jumps back up.

const STAGE_H = 390; // cap — +15% over the sheet-era 340 for the inline placement (Simon 2026-07-17)

export function CanvasPicker({ ops, onEnsureVisible }: {
  ops: AromaOps;
  /** Called after any tap that changes the refine target (arm OR drill) with
      the refine row's MEASURED window rect (top, height + breathing) — the
      inline host scrolls the minimal shift that makes the Add row fully
      visible (Simon 2026-07-17). The row measures ITSELF: no derived height
      math between host and picker to drift. */
  onEnsureVisible?: (topInWindow: number, height: number) => void;
}) {
  const familyColor = useAromaColors();
  // Drill path of node ids: [] = families, [familyId], [familyId, groupId].
  const [path, setPath] = useState<string[]>([]);
  const [pend, setPend] = useState<string | null>(null);
  // Travel direction of the last drill — the settle-in matches it.
  const [enterFrom, setEnterFrom] = useState(0.8);
  const target = pend ?? (path.length ? path[path.length - 1] : null);
  const pendState = usePendingAdd(target, ops);
  const refineRef = useRef<View | null>(null);
  // Post-tap, measure the refine row where it ACTUALLY is and ask the host
  // to bring it fully on screen. Twice: next frame, and again after a beat —
  // a drill changes the stage height and only the late pass sees the settled
  // layout (the AromaInput late-re-measure pattern).
  const ensureRefineVisible = () => {
    if (!onEnsureVisible) return;
    const measure = () =>
      refineRef.current?.measureInWindow((_x, y, _w, h) => {
        if (h > 0) onEnsureVisible(y, h + 12);
      });
    requestAnimationFrame(measure);
    setTimeout(measure, 200);
  };

  const family = path[0] ? AROMA_FAMILIES.find((f) => f.id === path[0]) : undefined;
  const group = path[1] && family ? family.subfamilies.find((s) => s.id === path[1]) : undefined;
  // Every cell wears the FAMILY colour, strictly — an alternating tone at
  // the group level read as foreign colours on device (Simon). The lattice
  // gap alone separates cells.
  const items: { id: string; label: string; familyId: string; drill: boolean }[] = group
    ? group.leaves.map((l) => ({ id: l.id, label: l.label, familyId: family!.id, drill: false }))
    : family
      ? family.subfamilies.map((s) => ({ id: s.id, label: s.label, familyId: family.id, drill: true }))
      : AROMA_FAMILIES.map((f) => ({ id: f.id, label: f.label, familyId: f.id, drill: true }));

  // Tile size = the Map's per-level radii (device round 2: the count-based
  // sizing left canvas tiles smaller than the map's — long labels like
  // "chemical" sat tighter here than there). path.length 0/1/2 → level 1/2/3;
  // import LEVEL_R so a future radius tweak can't silently break the parity.
  const R = LEVEL_R[(path.length + 1) as MapLevel];
  // Positions + a stage height SIZED TO the cluster (capped at STAGE_H): a
  // small comb vertically centred in the full-height stage floated in empty
  // bands (device round: "too much empty space above the cluster").
  const { pos, stageH } = useMemo(() => {
    const p = honeyXY(items.length, Math.sqrt(3) * R);
    const bh = Math.max(...p.map(([, y]) => y)) - Math.min(...p.map(([, y]) => y)) + 2 * R;
    return { pos: p, stageH: Math.min(STAGE_H, Math.ceil(bh) + 2 * STAGE_PAD) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const cells: HexCell[] = useMemo(() => {
    return items.map((it, i) => ({
      id: it.id,
      label: it.label,
      color: familyColor(it.familyId),
      x: pos[i][0],
      y: pos[i][1],
      pending: pend === it.id,
      muted: !!pend && pend !== it.id,
      pronounced: pend === it.id && pendState.pendP,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pos, familyColor, pend, pendState.pendP]);

  const onCell = (id: string) => {
    const it = items.find((c) => c.id === id);
    if (!it) return;
    if (it.drill) {
      setPath([...path, id]);
      setPend(null);
      setEnterFrom(0.8);
      ensureRefineVisible();
      return;
    }
    setPend((p) => (p === id ? null : id));
    ensureRefineVisible();
  };
  const popTo = (depth: number) => {
    setPath(path.slice(0, depth));
    setPend(null);
    setEnterFrom(1.18);
  };

  return (
    <View style={{ gap: 10 }}>
      <AromaCrumbs path={path} onPop={popTo} />
      <View style={{ marginHorizontal: -20 }}>
        <HexStage
          cells={cells}
          R={R}
          stageH={stageH}
          center={{ x: 0, y: 0 }}
          onCell={onCell}
          resetKey={path.join('/')}
          capFirst={capFirst}
          enterFrom={enterFrom}
          onSwipeBack={path.length ? () => popTo(path.length - 1) : undefined}
        />
      </View>
      {/* the search refine row — armed by a note tap (or the dived-into
          node, any-tier); its pending Pronounced draws the cell border.
          The ref wraps row + hint: the ensure-visible measure target. */}
      <View ref={refineRef} collapsable={false}>
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
    </View>
  );
}
