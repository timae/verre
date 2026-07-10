import { useEffect, useRef } from 'react';
import { View, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import {
  AROMA_FAMILIES,
  AROMA_MODIFIERS,
  aromaAllowedModifiers,
  aromaModifierDisplay,
  gateAromaSelections,
  getAromaNode,
  type AromaSelection,
} from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { AnchoredMenu, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, alpha } from '@/theme/color';
import { useTheme } from '@/theme';

// Shared building blocks for the aroma descriptor input (aroma-layer.md §6).
// Visual reference: the Vero handoff's 02e·11 search-first block + Simon's
// feedback round 1 (2026-07-10): every aroma tag sits on its FAMILY-TINTED
// fill — no leading dot, no check, and NO border; the single border in the
// system marks a PRONOUNCED tag. Words always read aroma first, modifier
// second ("Strawberry · jammy"). All data semantics come from @verre/core
// (any-tier nodes, upward-union modifier gating, (a, m) selections,
// pronounced flag `p`, gate canonicalization).
//
// Selection model in the UI: the browse pickers operate per NODE — a node
// reads as selected when ANY selection carries its id, toggling off removes
// all of them, and the modifier rail edits the node's (single) selection in
// place. The (a, m)-pair granularity (fig AND dried fig at once) stays
// reachable through search, where the Add bar appends a distinct pair.

// Taxonomy labels are stored lowercase ("green bell pepper"); the design
// renders sentence case ("Green bell pepper"). App-authored strings, so the
// user-content never-re-case rule doesn't apply.
export const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Tap-vs-double-tap discriminator (the mock's dbl() helper) — double-tap
// marks Pronounced (restored per feedback round 6, now that the search
// layout is stable enough to double-tap on). Two modes per call:
// - immediate: single fires on EVERY first tap; a second tap on the same key
//   within the window fires double INSTEAD (for cheap singles like focusing
//   a result).
// - delayed: single waits out the window and is cancelled by a double (for
//   singles that open a Modal — an immediate popup would swallow the second
//   tap on its backdrop).
export function useTapOrDouble(windowMs = 280) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKey = useRef<string | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (key: string, single: () => void, double: () => void, mode: 'immediate' | 'delayed' = 'immediate') => {
    if (lastKey.current === key && timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      lastKey.current = null;
      double();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    lastKey.current = key;
    if (mode === 'immediate') {
      single();
      timer.current = setTimeout(() => { timer.current = null; lastKey.current = null; }, windowMs);
    } else {
      timer.current = setTimeout(() => { timer.current = null; lastKey.current = null; single(); }, windowMs);
    }
  };
}

// The canonical form of one (a, m) pair — what the gate would store. UI that
// holds a pair as its TARGET (popup, rail armed block, search focus) must
// re-resolve through this after any edit: a promoted composite is rewritten
// (grape+dried → raisin), and a target left pointing at the pre-rewrite pair
// strands the UI on a selection that no longer exists (review finding).
export function canonicalPair(a: string, m: string | null): { a: string; m: string | null } {
  const gated = gateAromaSelections([{ a, m }]).value;
  return gated?.length ? { a: gated[0].a, m: gated[0].m } : { a, m };
}

// Display order for selected chips (Simon, 2026-07-10): PRONOUNCED first,
// then clustered by FAMILY in taxonomy order (matches the read surfaces'
// grouped-by-family rendering, aroma-layer.md §7, and calms the colour
// noise), insertion order within a family (stable sort). Display-only — the
// stored array keeps the taster's insertion order (the wire/archive shape is
// not a presentation concern).
const FAMILY_ORDER = new Map(AROMA_FAMILIES.map((f, i) => [f.id, i]));
export function displayOrder(value: AromaSelection[]): AromaSelection[] {
  const familyIdx = (a: string) => FAMILY_ORDER.get(getAromaNode(a)?.family.id ?? '') ?? AROMA_FAMILIES.length;
  return [...value].sort((x, y) => {
    const p = Number(!!y.p) - Number(!!x.p);
    if (p) return p;
    return familyIdx(x.a) - familyIdx(y.a);
  });
}

// The rendered words for a selection — aroma first, modifier second, comma-
// joined: "Strawberry, jammy", "Fig, dried", "Berry".
export function selectionLabel(sel: { a: string; m: string | null }): string {
  const node = getAromaNode(sel.a);
  if (!node) return sel.a;
  const name = capFirst(node.label);
  return sel.m ? `${name}, ${aromaModifierDisplay(sel.a, sel.m)}` : name;
}

// Controlled-value operations. Every write runs through the core gate so the
// UI state is always the canonical form (dedupe, promoted-percept rewrite,
// p-only-when-true). A write the gate rejects (over the 30 cap — a server
// bound, deliberately no visible counter) keeps the previous value; ops
// return whether the write LANDED so callers never celebrate a rejected add
// (Codex review, PR #77: the 31st add fired haptic + flash on nothing).
export type AromaOps = ReturnType<typeof useAromaOps>;
export function useAromaOps(value: AromaSelection[], onChange: (v: AromaSelection[]) => void) {
  const commit = (next: AromaSelection[]): boolean => {
    const gated = gateAromaSelections(next);
    if (!gated.value) return false;
    onChange(gated.value);
    return true;
  };
  const selectionFor = (a: string) => value.find((s) => s.a === a);
  return {
    value,
    selectionFor,
    isSelected: (a: string) => value.some((s) => s.a === a),
    isPronounced: (a: string) => value.some((s) => s.a === a && s.p),
    modifierOf: (a: string) => selectionFor(a)?.m ?? null,
    add: (sel: AromaSelection) => commit([...value, sel]),
    removeNode: (a: string) => commit(value.filter((s) => s.a !== a)),
    removePair: (a: string, m: string | null) => commit(value.filter((s) => s.a !== a || s.m !== m)),
    toggleNode: (a: string) => {
      if (value.some((s) => s.a === a)) commit(value.filter((s) => s.a !== a));
      else commit([...value, { a, m: null }]);
    },
    // PAIR-precise modifier edit — the only modifier op. A node carrying two
    // pairs (fig AND dried fig, both addable via search) must never have
    // both collapsed by one edit (review finding: a per-node map + gate
    // dedupe silently destroyed the second pair).
    setModifierPair: (a: string, oldM: string | null, m: string | null) =>
      commit(value.map((s) => (s.a === a && s.m === oldM ? { ...s, m } : s))),
    togglePronounced: (a: string, m: string | null) =>
      commit(
        value.map((s) => {
          if (s.a !== a || s.m !== m) return s;
          // Off: rebuild without `p` (canonical form carries it only when true).
          return s.p ? { a: s.a, m: s.m } : { ...s, p: true as const };
        }),
      ),
  };
}

// The aroma tag — selected chips, search results, and rail leaves share this
// one look: family-tinted fill, aroma-then-modifier words, no dot, no check.
// The ONLY border in the system marks a pronounced tag (a transparent border
// otherwise keeps layout stable). `muted` is the rail's not-yet-selected
// state (softer tint + softer ink); `focused` deepens the fill.
// The × is a CHILD Pressable inside the chip's Pressable — RN's responder
// system grants the touch to the deepest control, so an × tap does not also
// fire the chip press (the device-verified 02b pattern: photo overlay /
// corner badge inside the line-up row's Pressable).
export function AromaChip({
  a,
  m,
  pronounced,
  focused,
  muted,
  onPress,
  onRemove,
  sub,
}: {
  a: string;
  m: string | null;
  pronounced?: boolean;
  focused?: boolean;
  muted?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  // Light trailing tag — the coarse-tier marker in search results ("family" /
  // "group"), which also disambiguates the four leaf labels that equal a
  // subfamily label (honey / vanilla / cocoa / char).
  sub?: string;
}) {
  const { theme } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  if (!node) return null;
  const color = familyColor(node.family.id);
  // Focused/added chips step WELL past the resting tint (0.2 → 0.5) with the
  // text pulled toward ink — one shade apart wasn't readable in the results
  // wrap (feedback). ⚠️ Device-vet across themes: deep family fills sit on
  // surface, per the palette memory.
  const tintedInk = mix(color, theme.ink, focused ? 0.4 : 0.7);
  const fill = mix(color, theme.surface, muted ? 0.09 : focused ? 0.5 : 0.2);
  const label = selectionLabel({ a, m });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}${pronounced ? ', pronounced' : ''}`}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 4.5,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: pronounced ? tintedInk : 'transparent',
        backgroundColor: fill,
      }}
    >
      <VText
        surface="badge"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13.5, color: muted ? theme.inkSoft : tintedInk }}
      >
        {capFirst(node.label)}
        {m ? (
          <VText
            surface="badge"
            style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 13.5, color: muted ? theme.inkSoft : alpha(tintedInk, 0.75) }}
          >
            {', '}{aromaModifierDisplay(a, m)}
          </VText>
        ) : null}
      </VText>
      {sub ? (
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 11.5, color: theme.inkFaint }}>
          {sub}
        </VText>
      ) : null}
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${label}`}>
          <Icon name="x" size={13} color={tintedInk} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

// Modifier chips for one node, gated to its effective allowed set (leaves by
// declared inheritance, coarse nodes by descendant union — all from core).
// Renders nothing when the node allows no modifiers. Tone-only states (no
// borders): active = family tint, inactive = raised surface. `horizontal`
// renders one swipeable row (the compact search Add bar); default wraps.
export function ModifierRail({
  a,
  value,
  onChange,
  horizontal,
}: {
  a: string;
  value: string | null;
  onChange: (m: string | null) => void;
  horizontal?: boolean;
}) {
  const { theme } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  if (!node) return null;
  const allowed = aromaAllowedModifiers(a);
  if (!allowed.size) return null;
  const color = familyColor(node.family.id);
  const tintedInk = mix(color, theme.ink, 0.72);
  const chips = AROMA_MODIFIERS.filter((mod) => allowed.has(mod.id)).map((mod) => {
    const on = value === mod.id;
    return (
      <Pressable
        key={mod.id}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => onChange(on ? null : mod.id)}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 11,
          borderRadius: 999,
          // surfaceSunk at rest so the chip reads as a BADGE on any host
          // surface (the popup card is theme.surface — a surface-on-surface
          // chip was invisible there; feedback round 2).
          backgroundColor: on ? mix(color, theme.surface, 0.24) : theme.surfaceSunk,
        }}
      >
        <VText
          surface="badge"
          style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? tintedInk : theme.inkSoft }}
        >
          {capFirst(aromaModifierDisplay(a, mod.id))}
        </VText>
      </Pressable>
    );
  });
  if (horizontal) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 5 }}>
        {chips}
      </ScrollView>
    );
  }
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>{chips}</View>;
}

// The Pronounced toggle row — replaces the mock's double-tap gesture (ruled:
// an explicit per-selection toggle; display word "Pronounced", Simon
// 2026-07-10). Tone-only like the modifier chips; the hint flips with state.
export function PronouncedRow({
  a,
  on,
  onToggle,
}: {
  a: string;
  on: boolean;
  onToggle: () => void;
}) {
  const { theme } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  const color = node ? familyColor(node.family.id) : theme.accent;
  const tintedInk = mix(color, theme.ink, 0.72);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: on }}
        accessibilityLabel="Pronounced"
        onPress={onToggle}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 11,
          borderRadius: 999,
          borderWidth: 1.5,
          borderColor: on ? tintedInk : 'transparent',
          backgroundColor: on ? mix(color, theme.surface, 0.24) : theme.surfaceSunk,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="pronounced" size={13} color={on ? tintedInk : theme.inkSoft} />
          <VText
            surface="badge"
            style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? tintedInk : theme.inkSoft }}
          >
            Pronounced
          </VText>
        </View>
      </Pressable>
      <VText surface="badge" style={{ flex: 1, fontFamily: 'InstrumentSans_400Regular', fontSize: 12.5, color: theme.inkSoft }}>
        {on ? 'Stands out in this wine' : 'Mark if it stands out'}
      </VText>
    </View>
  );
}

// The chip refine POPUP — tapping a selected aroma tag opens this anchored
// panel (the mock's floating modPanel; Simon's feedback: the popup, NOT the
// bottom sheet — the sheet is only the "+N more" overflow). Rides the brand
// AnchoredMenu (Modal shell, tap-outside dismiss, flip-up-near-bottom) with
// refine content instead of menu rows.
export function ModifierPopup({
  target,
  onClose,
  ops,
  onTargetChange,
}: {
  // The selection being refined + where to anchor; null = closed. `right`
  // places the panel near the tapped chip (compare-sort pattern) instead of
  // spanning the screen.
  target: { a: string; m: string | null; anchor: MenuAnchor; right?: number } | null;
  onClose: () => void;
  ops: AromaOps;
  // Lets the owner re-key its target after a modifier edit — with the
  // CANONICAL pair, which may be a different node (grape+dried → raisin).
  onTargetChange: (pair: { a: string; m: string | null }) => void;
}) {
  const { theme } = useTheme();
  const { width: screenW } = useWindowDimensions();
  // Hold the last target so content survives the close fade (AnchoredMenu
  // renders a frame after `anchor` nulls — same trick as its own `last`).
  const last = useRef<{ a: string; m: string | null } | null>(null);
  if (target) last.current = { a: target.a, m: target.m };
  const sel = target ? { a: target.a, m: target.m } : last.current;
  const width = Math.min(280, screenW - 32);
  return (
    <AnchoredMenu anchor={target?.anchor ?? null} onClose={onClose} minWidth={width} right={target?.right ?? 16}>
      {sel ? (
        <View style={{ padding: 12, gap: 9 }}>
          <VText variant="small" color="inkSoft">
            Refine{' '}
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>
              {capFirst(getAromaNode(sel.a)?.label ?? sel.a)}
            </VText>
          </VText>
          <ModifierRail
            a={sel.a}
            value={sel.m}
            onChange={(m) => {
              ops.setModifierPair(sel.a, sel.m, m);
              // Re-target on the CANONICAL pair — a promoted composite
              // (grape+dried) was just rewritten to its leaf (raisin), and a
              // stale target would make the toggles below silently no-op.
              onTargetChange(canonicalPair(sel.a, m));
            }}
          />
          <PronouncedRow
            a={sel.a}
            on={ops.value.some((s) => s.a === sel.a && s.m === sel.m && s.p)}
            onToggle={() => ops.togglePronounced(sel.a, sel.m)}
          />
        </View>
      ) : null}
    </AnchoredMenu>
  );
}
