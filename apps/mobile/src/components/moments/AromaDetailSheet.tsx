import { useMemo, useRef } from 'react';
import { findNodeHandle, useWindowDimensions, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetView, type BottomSheetScrollViewMethods } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ConsensusDisplayNode } from '@verre/core';
import { AromaChip } from '@/components/scoring/aroma/parts';
import { shouldScrollAromaDetail, STRIP_GAP, type CompareAromaModel } from './aromaCompareView';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// Tier 3 — the full aroma detail in a bottom sheet (compare §9, slice 3c).
// Renders from the SAME CompareAromaModel the strip consumes (one derivation in
// CompareBody — strip and sheet can't fork). Two modes, same fork as the strip:
// - agreement: the WHOLE consensus tree (context ancestors, headings, nested
//   peaks the strip omits), then an "All aromas" section — every exact
//   (base, modifier) pick, so singleton aromas that never reach consensus are
//   still readable here (Codex product ruling, 2026-07-15).
// - fallback (no agreement): the flat modifier-preserving all-aromas read.
// Opened by the strip's "Aroma details" and the popover's "+N more" (which
// passes a focusId — that branch is highlighted + scrolled to).
//
// Role drives emphasis, NOT a debug tag: a primary is the emphasized head
// (accent hairline + bold), a secondary is a plainer counted head, a context
// ancestor is a quieter chip above its primary, a peak is a chip indented under
// its branch, and an uncounted heading is a quiet family grouping label.

function ConsensusRow({ dn, depth, pronouncedIds, focusId, focusRef }: {
  dn: ConsensusDisplayNode;
  depth: number;
  pronouncedIds: ReadonlySet<string>;
  focusId?: string;
  /** Attached to the row that matches focusId, so the sheet can measure + scroll
      it into view in scroll mode. */
  focusRef?: React.RefObject<View | null>;
}) {
  const { theme } = useTheme();
  const { counted, role, node, children } = dn;
  const focused = focusId != null && node.id === focusId;
  // FOCUS overrides every role — an accent rail + accent-tinted backing, whatever
  // the node's role (a focused secondary must read as focused too). Otherwise the
  // role distinction: primary = ink rail, secondary = faint rail, context =
  // quieter (0.75), peak = slightly quieted (0.9), heading = its label style.
  const rail: { w: number; c: string } = focused
    ? { w: 2, c: theme.accent }
    : role === 'primary' ? { w: 2, c: theme.ink }
      : role === 'secondary' ? { w: 2, c: theme.rule }
        : { w: 0, c: 'transparent' };
  const rowOpacity = focused ? 1 : role === 'context' ? 0.75 : role === 'peak' ? 0.9 : 1;
  return (
    <View style={{ gap: 8 }}>
      <View
        ref={focused ? focusRef : undefined}
        collapsable={false}
        style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: depth * 18 }}
      >
        <View style={{ borderLeftWidth: rail.w, borderLeftColor: rail.c, paddingLeft: rail.w > 0 ? 8 : 0, opacity: rowOpacity, backgroundColor: focused ? theme.accentTint : 'transparent', borderRadius: focused ? radius.sm : 0 }}>
          {counted ? (
            <AromaChip a={node.id} m={null} count={node.count} pronounced={pronouncedIds.has(node.id)} vPad={0} />
          ) : (
            // Uncounted grouping heading — a quiet family label, no chip fill (its
            // count would read as additive with its children, §rule 6).
            <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.inkFaint }}>
              {node.label}
            </VText>
          )}
        </View>
      </View>
      {children.map((c) => (
        <ConsensusRow key={c.node.id} dn={c} depth={depth + 1} pronouncedIds={pronouncedIds} focusId={focusId} focusRef={focusRef} />
      ))}
    </View>
  );
}

export function AromaDetailSheet({
  open,
  onClose,
  model,
  wineName,
  focusId,
}: {
  open: boolean;
  onClose: () => void;
  /** The parent-computed compare-aroma model (same instance the strip renders). */
  model: CompareAromaModel;
  wineName: string;
  /** Node the popover "+N more" was viewing; its branch is highlighted. */
  focusId?: string;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const focusRef = useRef<View | null>(null);
  const { result, hasAgreement, allAromas, pronouncedIds } = model;

  // In scroll mode, bring the focused node (the popover "+N more" target) into
  // view once the content has laid out — ONCE per open (the sheet remounts per
  // open, so a plain ref suffices). Without the guard, any later content resize
  // (poll update, font change) would yank the user's scroll back to the focus
  // row. `onContentSizeChange` CAN fire before the refs are usable, so this
  // retries on a bounded rAF chain until both refs resolve.
  const didScroll = useRef(false);
  const scrollToFocus = (attempt = 0) => {
    if (!focusId || didScroll.current) return;
    const node = focusRef.current;
    const scroll = scrollRef.current;
    // gorhom exposes the underlying scrollable node via getScrollableNode() —
    // measureLayout needs THAT node handle, not the methods wrapper.
    const scrollNode = scroll?.getScrollableNode?.();
    const scrollHandle = scrollNode != null ? findNodeHandle(scrollNode) : null;
    if (!node || !scroll || scrollHandle == null) {
      if (attempt < 5) requestAnimationFrame(() => scrollToFocus(attempt + 1));
      return;
    }
    node.measureLayout(
      scrollHandle,
      (_x, y) => {
        didScroll.current = true;
        scroll.scrollTo({ y: Math.max(0, y - 24), animated: true });
      },
      () => { if (attempt < 5) requestAnimationFrame(() => scrollToFocus(attempt + 1)); },
    );
  };

  const head = (
    <View style={{ gap: 2, paddingBottom: 12 }}>
      <VText variant="heading">
        {hasAgreement ? (result.hasStrongAgreement ? 'What the group agreed on' : 'What the group mentioned') : result.n >= 2 ? 'Aromas mentioned' : 'Aromas'}
      </VText>
      <VText variant="small" color="inkSoft">{wineName}</VText>
    </View>
  );

  // The modifier-preserving all-aromas read (from the model): every exact pick.
  // In agreement mode it follows the tree under its own quiet section label —
  // singleton (count-1) aromas are visible ONLY here; in fallback it IS the body.
  const allAromasGrid = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
      {allAromas.length > 0 ? (
        allAromas.map((c) => <AromaChip key={c.key} a={c.a} m={c.m} count={c.count} vPad={0} />)
      ) : (
        <VText variant="small" color="inkFaint">No aromas yet.</VText>
      )}
    </View>
  );

  const body = hasAgreement ? (
    <View style={{ gap: 12 }}>
      {result.roots.map((r) => <ConsensusRow key={r.node.id} dn={r} depth={0} pronouncedIds={pronouncedIds} focusId={focusId} focusRef={focusRef} />)}
      <View style={{ gap: 8, marginTop: 6 }}>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, letterSpacing: 0.3, color: theme.inkSoft }}>All aromas</VText>
        {allAromasGrid}
      </View>
    </View>
  ) : (
    allAromasGrid
  );

  // Cap-aware two-mode sizing (apps/mobile CLAUDE.md): dynamic-fit + plain
  // BottomSheetView while the content fits; a fixed 85% snap + BottomSheetScrollView
  // once it can't. Decided BEFORE first render (a measure-then-flip would clip /
  // flash a frame) by the pure, harness-pinned shouldScrollAromaDetail — the
  // estimate is the COMBINED tree + All-aromas height (either half can fit alone
  // while the sum overflows), with the >12-chip count gate as the long-label
  // backstop.
  const nodeCount = useMemo(() => {
    let n = 0;
    const walk = (dn: ConsensusDisplayNode) => { n += 1; dn.children.forEach(walk); };
    result.roots.forEach(walk);
    return n;
  }, [result]);
  const cap = windowH * 0.85;
  const needsScroll = shouldScrollAromaDetail({
    hasAgreement,
    nodeCount,
    allAromasCount: allAromas.length,
    cap,
    base: 120 + insets.bottom,
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      {...(needsScroll ? { snapPoints: ['85%'], enableDynamicSizing: false } : { maxDynamicContentSize: cap })}
    >
      {needsScroll ? (
        <BottomSheetView style={{ flex: 1, paddingHorizontal: 18 }}>
          {head}
          <BottomSheetScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
            onContentSizeChange={() => scrollToFocus()}
          >
            {body}
          </BottomSheetScrollView>
        </BottomSheetView>
      ) : (
        <BottomSheetView style={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 12 }}>
          {head}
          {body}
        </BottomSheetView>
      )}
    </Sheet>
  );
}
