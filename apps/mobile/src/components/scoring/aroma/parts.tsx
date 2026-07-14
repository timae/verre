import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import {
  AROMA_FAMILIES,
  AROMA_MODIFIERS,
  AROMA_SELECTION_CAP,
  aromaAllowedModifiers,
  aromaModifierDisplay,
  gateAromaSelections,
  getAromaNode,
  type AromaSelection,
} from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { usePhoneTokens } from '@/lib/layout';
import { useAromaColors } from '@/theme/flavourColors';
import { mix, alpha, inkOn, readableSolid, readableBorder } from '@/theme/color';
import { aromaArmedInk, aromaFillRatio } from './aromaTint';
import { motion, useTheme } from '@/theme';

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
    toggleNode: (a: string): boolean =>
      value.some((s) => s.a === a)
        ? commit(value.filter((s) => s.a !== a))
        : commit([...value, { a, m: null }]),
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

// Badge vertical metrics for a vPad value (the height axis — AromaChip +
// MoreChipsPill share it so a capped row stays one height). Padding floors at
// 0; the negative range squeezes the label's line box instead. Base 23 = the
// body variant's lineHeight (15 × 1.55) the badge VText inherits — the inline
// fontSize 13.5 overrides the size but NOT the line box. Factor 2 keeps the
// height rate uniform across the whole range (padding shrinks 2×vPad per
// unit too).
export const badgeVMetrics = (vPad: number | undefined) => ({
  padV: vPad == null ? 4.5 : Math.max(0, vPad),
  lineH: vPad != null && vPad < 0 ? Math.max(13.5, 23 + vPad * 2) : undefined,
});

// The aroma tag — selected chips, search results, and rail leaves share this
// one look: family-tinted fill, aroma-then-modifier words, no dot, no check.
// The ONLY border in the system marks a pronounced tag (a transparent border
// otherwise keeps layout stable). `muted` is the rail's not-yet-selected
// state (softer tint + softer ink); `focused` deepens the fill.
// The × is a CHILD Pressable inside the chip's Pressable — RN's responder
// system grants the touch to the deepest control, so an × tap does not also
// fire the chip press (the device-verified 02b pattern: photo overlay /
// corner badge inside the line-up row's Pressable).
// Badge anatomy = the design system's `.badge` pattern (vero-components.css)
// with Simon's readability ruling (2026-07-10 gallery pass): resting =
// family-tinted fill (aromaFillRatio per-theme/family bumps) + readableSolid
// words — the 100% palette colour wherever it clears 3:1 on the fill, pulled
// toward ink only past that (supersedes both the ink-pulled tintedInk AND
// the bare-solid-words iterations); focused/armed (and 'solid'-bumped fills)
// = SOLID family-colour fill + contrast-picked label (inkOn — the hex
// cells' treatment). Pronounced border = the full family colour on tinted
// fills, the label ink on solid fills (same-colour border would vanish).
export function AromaChip({
  a,
  m,
  pronounced,
  focused,
  armedDot,
  pale,
  mapSolid,
  muted,
  onPress,
  onRemove,
  sub,
  count,
  tint,
  monoWords,
  tintSolid,
  vPad,
}: {
  a: string;
  m: string | null;
  pronounced?: boolean;
  /** The SOLID armed flip (full family fill + inkOn words). ⚠️ NOT the
      search treatment anymore — Simon's 2026-07-12 ruling: an armed search
      result keeps its resting colours and the SIBLINGS mute (`muted`).
      `focused` remains for surfaces that keep the solid armed look. */
  focused?: boolean;
  /** EXPLORATION (dev gallery, 2026-07-12): the Map/Canvas focus treatment's
      sibling PALE — the hexStage mute: 0.35 family tint, words contrast-
      picked vs the actual pale fill (inkOn — family-tinted ink washed out on
      the pastel, the map's round-5 device finding). Visibly alive unlike
      `muted` (the rail's faint 0.09). Used while another chip is armed. */
  pale?: boolean;
  /** EXPLORATION (dev gallery, 2026-07-12): render as a MAP CELL — the flat
      SOLID family fill + inkOn words (hexStage's normal state; no armed ink
      boost). The map's armed signal is contextual: armed stays this solid
      while siblings go `pale`. */
  mapSolid?: boolean;
  /** EXPLORATION (dev gallery, 2026-07-12): leading round mark — the
      ListPicker's "round mark = armed" vocabulary on a chip. Explicit,
      colour-independent, so it works on the punch-list combos where fill
      deltas can't. The CALLER gates it on its own armed notion (ruled-mode
      armed chips carry no `focused`, so the chip can't infer armed itself). */
  armedDot?: boolean;
  muted?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  /** EXPLORATION override (dev gallery): render the badge in this colour
      instead of the family colour — the mono/theme-coloured comparison. */
  tint?: string;
  /** EXPLORATION (dev gallery, with `tint`): keep the mono fill but write
      the words in the family colour — 'resting' = the resting row's EXACT
      font (readableSolid vs the family's own resting fill, NOT re-corrected
      against the mono fill — that pulled most families to ink on clay),
      'solid' = the 100% palette colour. */
  monoWords?: 'resting' | 'solid';
  /** EXPLORATION (dev gallery, with `tint`): the fill is the 100% SOLID tint
      colour instead of its badge transparency. */
  tintSolid?: boolean;
  /** Badge-height axis (the dev gallery's slider; see badgeVMetrics). WRITE
      surfaces keep the 4.5 default; READ surfaces (AromaReadChips — feed
      impression detail, compare when it grows aromas) ship the compact 0
      (Simon, 2026-07-13). Below the padding floor the text line box binds the
      height, so NEGATIVE values keep padding at 0 and tighten the label
      lineHeight instead (continuing the shrink past what padding alone
      allows). */
  vPad?: number;
  // Light trailing tag — the coarse-tier marker in search results ("family" /
  // "group"), which also disambiguates the four leaf labels that equal a
  // subfamily label (honey / vanilla / cocoa / char).
  sub?: string;
  // Leading agreement count INSIDE the pill — the compare roll-up's "Nx Label"
  // (Simon's ruling: the count lives in the badge, not beside it, and the glyph
  // is a plain ASCII "x", not "×"). Rendered as a "3x " prefix on the fill
  // (words colour) and spoken as "N tasters, Label" for VoiceOver. This
  // canonical-chip reuse is the SETTLED production visual — the §8 compare
  // surface will pass this same prop, no compare-specific wrapper.
  count?: number;
}) {
  const { theme, themeKey } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  if (!node) return null;
  const color = tint ?? familyColor(node.family.id);
  // (famColor below stays the true family colour even under a tint override.)
  // Fill ratio via aromaFillRatio (clay boost, 1:1 elsewhere; a tint
  // override skips the per-family bumps); focused goes SOLID colour.
  // `pale` = the hexStage sibling-mute fill (flat 0.35, no per-family boosts
  // — the map's own value); `mapSolid` = the hexStage normal cell (flat 1.0).
  // Both bypass aromaFillRatio: the map's values are already device-ruled.
  const restingR = tint && tintSolid ? 1 : pale ? 0.35 : mapSolid ? 1 : aromaFillRatio(themeKey, tint ? '' : node.family.id, muted ? 0.09 : 0.2);
  // ARMED (solid) fills pull toward ink where the bare palette colour reads
  // weak against the theme (aromaArmedInk — Simon's 2026-07-12 gallery pass);
  // resting fills (incl. the resting 'solid' bumps) never do. mapSolid never
  // ink-boosts: the map's armed cell IS the plain solid — its armed signal
  // comes from the siblings' pale, not from self-mutation. (An ink pull on
  // TINTED fills was tried and REJECTED as hue-muddying — see aromaTint.ts.)
  const armedInk = focused && !tint && !mapSolid ? aromaArmedInk(themeKey, node.family.id) : 0;
  const fill = focused || restingR >= 1
    ? (armedInk ? mix(color, theme.ink, armedInk) : color)
    : mix(color, theme.surface, restingR);
  // A 'solid' fill (focused, a per-family bump like clay Fruity, or the mono
  // rows' tintSolid switch) — border/words then need the focused treatment.
  const onSolid = focused || restingR >= 1;
  const famColor = familyColor(node.family.id);
  // The family's RESTING font colour (row 1 of the gallery) — reused verbatim
  // by the mono rows' 'resting' words mode.
  const famResting = () =>
    readableSolid(famColor, theme.ink, mix(famColor, theme.surface, aromaFillRatio(themeKey, node.family.id, 0.2)));
  const words = muted
    ? theme.inkSoft
    : tint && monoWords
      ? monoWords === 'solid'
        ? famColor
        : famResting()
      : onSolid || pale
        ? inkOn(fill, theme.ink, theme.bg)
        : readableSolid(color, theme.ink, fill);
  const label = selectionLabel({ a, m });
  const { padV, lineH } = badgeVMetrics(vPad);
  // Pronounced border wears the READABLE BORDER accent — corrected like the
  // words but floored at 45% colour share (a full ink pull made clay's
  // borders read WHITE; bare colour was invisible on mauve Sweet / cobalt
  // Funky / charcoal Fire — Simon's passes). On a mono tint the Pronounced
  // border is the 100% SOLID family colour (Simon — the family identity
  // carries entirely in the border there); family-coloured chips keep the
  // readableBorder correction.
  const ring = pronounced ? (tint ? famColor : muted ? color : onSolid ? words : readableBorder(color, theme.ink, fill)) : null;
  return (
    <Pressable
      // Read-only chips (AromaReadChips) pass no onPress — announcing them
      // as buttons would give VoiceOver N inert controls per row.
      accessibilityRole={onPress ? 'button' : 'text'}
      // When a count is shown ("3x Strawberry"), speak it — the visible ASCII
      // "3x" is a glyph a screen reader shouldn't read literally.
      accessibilityLabel={`${count != null ? `${count} taster${count === 1 ? '' : 's'}, ` : ''}${label}${pronounced ? ', pronounced' : ''}`}
      onPress={onPress}
      // The "border" is the outer pill's 1.5 padding band in the ring colour
      // with the fill on a nested pill — NOT borderWidth/borderColor: RN
      // paints a view's rounded background to the OUTER edge and strokes the
      // border inside it, so on a 999-radius pill the fill's antialiased
      // edge peeked past the border along the curves (device finding,
      // 2026-07-12). Stacked pills can't bleed. Padding 1.5 replaces the old
      // borderWidth 1.5, so the footprint is unchanged and toggling
      // pronounced still never shifts content.
      style={{ borderRadius: 999, padding: 1.5, backgroundColor: ring ?? fill }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: padV,
          paddingHorizontal: 12,
          borderRadius: 999,
          backgroundColor: fill,
        }}
      >
      {armedDot ? (
        <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: words }} />
      ) : null}
      {/* (A bold-on-armed weight signal was tried and RULED insufficient —
          Simon, 2026-07-12. Don't re-add; the armed cues are fill, siblings
          muting, and the round mark below.) */}
      <VText
        surface="badge"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13.5, color: words, ...(lineH != null ? { lineHeight: lineH } : null) }}
      >
        {count != null ? `${count}x ` : ''}
        {capFirst(node.label)}
        {m ? (
          <VText
            surface="badge"
            style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 13.5, color: muted ? theme.inkSoft : alpha(words, 0.75) }}
          >
            {', '}{aromaModifierDisplay(a, m)}
          </VText>
        ) : null}
      </VText>
      {sub ? (
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 11.5, color: focused ? alpha(words, 0.7) : theme.inkFaint }}>
          {sub}
        </VText>
      ) : null}
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${label}`}>
          <Icon name="x" size={13} color={words} />
        </Pressable>
      ) : null}
      </View>
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
  const { theme, themeKey } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  if (!node) return null;
  const allowed = aromaAllowedModifiers(a);
  if (!allowed.size) return null;
  const color = familyColor(node.family.id);
  const onFill = mix(color, theme.surface, aromaFillRatio(themeKey, node.family.id, 0.24));
  const onWords = readableSolid(color, theme.ink, onFill);
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
          backgroundColor: on ? onFill : theme.surfaceSunk,
        }}
      >
        <VText
          surface="badge"
          style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? onWords : theme.inkSoft }}
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
  const { theme, themeKey } = useTheme();
  const familyColor = useAromaColors();
  const node = getAromaNode(a);
  const color = node ? familyColor(node.family.id) : theme.accent;
  const onR = aromaFillRatio(themeKey, node?.family.id ?? '', 0.24);
  const onFill = onR >= 1 ? color : mix(color, theme.surface, onR);
  // A 'solid' per-family fill (clay Fire etc.) takes the label-ink treatment
  // for BOTH words and border — readableBorder floors at 45% share, which on
  // a same-colour solid fill measured ~1.9:1 (review finding).
  const onSolid = onR >= 1;
  const onWords = onSolid ? inkOn(color, theme.ink, theme.bg) : readableSolid(color, theme.ink, onFill);
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
          // The Pronounced border wears the READABLE BORDER accent (45%
          // colour floor — the words' full pull went white on clay); on a
          // solid fill it takes the label ink, like the chip.
          borderColor: on ? (onSolid ? onWords : readableBorder(color, theme.ink, onFill)) : 'transparent',
          backgroundColor: on ? onFill : theme.surfaceSunk,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="pronounced" size={13} color={on ? onWords : theme.inkSoft} />
          <VText
            surface="badge"
            style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? onWords : theme.inkSoft }}
          >
            Pronounced
          </VText>
        </View>
      </Pressable>
      <VText surface="badge" style={{ flex: 1, fontFamily: 'InstrumentSans_400Regular', fontSize: 12.5, color: theme.inkSoft }}>
        {/* category-neutral (not only wines); pairs with the off-state copy */}
        {on ? 'Stands out' : 'Mark if it stands out'}
      </VText>
    </View>
  );
}

// Pending-add state for the browse pickers (the mock's pend/pendMod/pendDom):
// a modifier + Pronounced armed against the current pick, committed as one
// pair. Resets when the target changes. `added` keys on the CANONICAL pair
// (a promoted composite like grape+dried reads as its leaf) — an exact
// already-added match greys the commit to "Added", no Update semantics
// (ADR-0008). A cap-rejected commit answers with the warning haptic + the
// `CapHint` line — the SAME COPY the inline input shows (a rejection message,
// never a live counter); the two differ only in tone/alignment by surface
// (browse-sheet CapHint = accent/left; the impression input = critical/
// centred, device-passed). `capHit` clears once a removal makes room.
export function usePendingAdd(target: string | null, ops: AromaOps) {
  const [pendM, setPendM] = useState<string | null>(null);
  const [pendP, setPendP] = useState(false);
  const [capHit, setCapHit] = useState(false);
  useEffect(() => {
    setPendM(null);
    setPendP(false);
  }, [target]);
  useEffect(() => {
    if (ops.value.length < AROMA_SELECTION_CAP) setCapHit(false);
  }, [ops.value.length]);
  const canon = target ? canonicalPair(target, pendM) : null;
  const added = !!canon && ops.value.some((s) => s.a === canon.a && s.m === canon.m);
  // Retargeting AWAY from an added pair drops pending Pronounced: the toggle
  // rendered off+disabled there (`p && !added`), so a surviving true would
  // silently arm the next addable pair (mirrors AromaInput's onM).
  const retargetM = (m: string | null) => {
    if (added) setPendP(false);
    setPendM(m);
  };
  const commit = (): boolean => {
    if (!target || added) return false;
    const ok = ops.add(pendP ? { a: target, m: pendM, p: true } : { a: target, m: pendM });
    if (!ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setCapHit(true);
      return false;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPendM(null);
    setPendP(false);
    return true;
  };
  return { pendM, setPendM: retargetM, pendP, togglePendP: () => setPendP((p) => !p), capHit, added, commit };
}

// The cap-rejection hint line (shared copy with the inline input).
export function CapHint({ show }: { show: boolean }) {
  const { theme } = useTheme();
  if (!show) return null;
  return (
    <VText variant="small" style={{ color: theme.accent }}>
      Limit reached — an impression holds up to {AROMA_SELECTION_CAP} aromas.
    </VText>
  );
}

// (The pickers consume usePendingAdd + RefineAddRow directly — Map/Canvas
// also feed the armed cell's Pronounced border from pendP; Rings renders the
// same shared RefineAddRow BELOW its wheel. The corner-controls design was
// abandoned during the Rings rewrite — don't resurrect it from old comments.)

// The "it landed HERE" cue on the chip a fresh Add produced (or the "+N
// more" pill when the ordering files it into the overflow): a LIGHT-UP — an
// accent veil flashes over the chip and fades (device feedback: a bare scale
// pulse read as nothing), plus a slight lift. Motion tokens only.
export function FlashPulse({ on, children }: { on: boolean; children: React.ReactNode }) {
  const { theme } = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) return;
    v.setValue(0);
    Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: motion.dur1, easing: Easing.bezier(...motion.easeOut), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: motion.dur3, easing: Easing.bezier(...motion.ease), useNativeDriver: true }),
    ]).start();
  }, [on, v]);
  return (
    <Animated.View style={{ transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] }}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: 999,
          backgroundColor: theme.accent,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }),
        }}
      />
    </Animated.View>
  );
}

// Overflow is WIDTH-based (device round 7 — a chip count ignores label
// length): chips greedily pack into up to MAX_LINES rows of the row's
// measured width using each chip's REAL rendered width (a hidden measuring
// pass; estimates cut a fittable chip, device follow-up), and the "+N more"
// pill must fit within those lines too — chips pop off the tail until it
// does. Hard ceiling TWO lines (Simon's correction of the initial three).
// Shared by the rating page's SelectedChipsRow and the read-only
// AromaReadChips collapse — one packer, one pill, one measuring pass.
const MAX_LINES = 2;
export const CHIP_GAP = 6;
// Fallbacks until the hidden pass reports (first frame only). `xW` = the
// trailing ×'s share — read-only chips have none.
const chipEstW = (sel: { a: string; m: string | null }, xW: number) => 27 + Math.ceil(selectionLabel(sel).length * 7.2) + xW;
const pillEstW = (n: number) => 24 + Math.ceil(`+${n} more`.length * 7.5);
export const pairKey = (s: { a: string; m: string | null }) => `${s.a}|${s.m ?? ''}`;

// Greedy line packing over measured (fallback: estimated) widths: how many
// whole chips fit in MAX_LINES rows of `rowW`, and — when some don't — how
// many after making room for the "+N more" pill on the last line.
export function packChips(
  ordered: AromaSelection[],
  rowW: number,
  chipW: Record<string, number>,
  opts?: { gap?: number; removable?: boolean },
): { visible: AromaSelection[]; overflow: number } {
  if (rowW <= 0) return { visible: ordered, overflow: 0 };
  const gap = opts?.gap ?? CHIP_GAP;
  const xW = opts?.removable === false ? 0 : 19;
  const states: { line: number; cursor: number }[] = [{ line: 1, cursor: 0 }];
  let line = 1;
  let cursor = 0;
  let fit = 0;
  for (const sel of ordered) {
    const w = chipW[pairKey(sel)] ?? chipEstW(sel, xW);
    let nl = line;
    let nc = cursor;
    if (nc > 0 && nc + gap + w > rowW) {
      nl += 1;
      nc = w;
    } else {
      nc += (nc > 0 ? gap : 0) + w;
    }
    if (nl > MAX_LINES) break;
    line = nl;
    cursor = nc;
    fit += 1;
    states.push({ line, cursor });
  }
  if (fit >= ordered.length) return { visible: ordered, overflow: 0 };
  let count = fit;
  while (count > 0) {
    const pw = pillEstW(ordered.length - count);
    const st = states[count];
    let nl = st.line;
    let nc = st.cursor;
    if (nc > 0 && nc + gap + pw > rowW) {
      nl += 1;
      nc = pw;
    } else {
      nc += (nc > 0 ? gap : 0) + pw;
    }
    if (nl <= MAX_LINES) break;
    count -= 1;
  }
  return { visible: ordered.slice(0, count), overflow: ordered.length - count };
}

// Hidden measuring pass — renders each not-yet-measured chip once at its
// natural width (off-screen, invisible) so the packer works with real
// numbers. `removable` must match how the visible chips render: the × is
// part of the width.
export function ChipMeasurePass({
  selections,
  chipW,
  onMeasure,
  removable,
  vPad,
}: {
  selections: AromaSelection[];
  chipW: Record<string, number>;
  onMeasure: (key: string, w: number) => void;
  removable?: boolean;
  vPad?: number;
}) {
  const unmeasured = selections.filter((sel) => !(pairKey(sel) in chipW));
  if (!unmeasured.length) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: 4000, opacity: 0, flexDirection: 'row' }}>
      {unmeasured.map((sel) => {
        const key = pairKey(sel);
        return (
          <View key={key} onLayout={(e) => onMeasure(key, Math.ceil(e.nativeEvent.layout.width))}>
            <AromaChip a={sel.a} m={sel.m} pronounced={!!sel.p} onRemove={removable ? () => {} : undefined} vPad={vPad} />
          </View>
        );
      })}
    </View>
  );
}

// The "+N more" overflow pill — the tail of a capped chip row. `vPad` must
// match the row's chips so the pill sits at their height (its padding carries
// the chips' 1.5 border band on top of the shared metric).
export function MoreChipsPill({ count, onPress, vPad }: { count: number; onPress: () => void; vPad?: number }) {
  const { theme } = useTheme();
  const { padV, lineH } = badgeVMetrics(vPad);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} more aromas`}
      onPress={onPress}
      style={{
        justifyContent: 'center',
        paddingVertical: padV + 1.5, // no border — visually matches the chips' padV+1.5
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: theme.surface,
      }}
    >
      <VText
        surface="badge"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.inkSoft, ...(lineH != null ? { lineHeight: lineH } : null) }}
      >
        +{count} more
      </VText>
    </Pressable>
  );
}
// THE selected-aromas block — one behaviour everywhere (device round 4: the
// browse sheet must read exactly like the impression page). Wrapped chips in
// display order, tap = refine popup / double-tap = Pronounced / × removes,
// and the light-up flash on a fresh add — detected by DIFFING the value, so
// it fires no matter which surface (search row, a picker, the sheet)
// committed it; the pill flashes when the ordering files the add into the
// overflow.
export function SelectedChipsRow({ ops, onOverflow }: { ops: AromaOps; onOverflow: () => void }) {
  const { width: screenW } = useWindowDimensions();
  const [rowW, setRowW] = useState(0);
  // Real chip widths from the hidden measuring pass, keyed by pair.
  const [chipW, setChipW] = useState<Record<string, number>>({});
  const [popup, setPopup] = useState<{ a: string; m: string | null; anchor: MenuAnchor; right?: number } | null>(null);
  const chipRefs = useRef<Record<string, View | null>>({});
  const tap = useTapOrDouble();
  const [flash, setFlash] = useState<string | null>(null);
  const prevKeys = useRef<Set<string>>(new Set(ops.value.map(pairKey)));
  useEffect(() => {
    const keys = new Set(ops.value.map(pairKey));
    const fresh = [...keys].filter((k) => !prevKeys.current.has(k));
    // Only a GROWN set flashes — a refine edit swaps a pair without adding.
    const grew = keys.size > prevKeys.current.size;
    prevKeys.current = keys;
    if (fresh.length && grew) setFlash(fresh[0]);
  }, [ops.value]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 800);
    return () => clearTimeout(t);
  }, [flash]);

  if (!ops.value.length) return null;
  const ordered = displayOrder(ops.value);
  const { visible, overflow } = packChips(ordered, rowW, chipW);
  return (
    <View onLayout={(e) => setRowW(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: CHIP_GAP }}>
      <ChipMeasurePass
        selections={ordered}
        chipW={chipW}
        onMeasure={(key, w) => setChipW((m) => (m[key] === w ? m : { ...m, [key]: w }))}
        removable
      />
      {visible.map((sel) => {
        const key = pairKey(sel);
        return (
          <View key={key} ref={(n) => { chipRefs.current[key] = n; }} collapsable={false}>
            <FlashPulse on={flash === key}>
              <AromaChip
                a={sel.a}
                m={sel.m}
                pronounced={!!sel.p}
                // single tap = refine popup (delayed past the double window —
                // an instant Modal would swallow the second tap); double tap
                // = toggle Pronounced directly.
                onPress={() =>
                  tap(
                    `chip:${key}`,
                    () =>
                      chipRefs.current[key]?.measureInWindow((x, y, _w, h) =>
                        setPopup({ a: sel.a, m: sel.m, anchor: { top: y, bottom: y + h }, right: Math.max(12, screenW - x - 280) }),
                      ),
                    () => ops.togglePronounced(sel.a, sel.m),
                    'delayed',
                  )
                }
                onRemove={() => {
                  delete chipRefs.current[key];
                  if (popup?.a === sel.a && popup?.m === sel.m) setPopup(null);
                  ops.removePair(sel.a, sel.m);
                }}
              />
            </FlashPulse>
          </View>
        );
      })}
      {overflow > 0 ? (
        // The pill pulses when the fresh add filed into the overflow.
        <FlashPulse on={!!flash && !visible.some((sel) => pairKey(sel) === flash)}>
          <MoreChipsPill count={overflow} onPress={onOverflow} />
        </FlashPulse>
      ) : null}
      <ModifierPopup
        target={popup}
        onClose={() => setPopup(null)}
        ops={ops}
        onTargetChange={(pair) => setPopup((p) => (p ? { ...p, ...pair } : p))}
      />
    </View>
  );
}

// The drill breadcrumb shared by the Rail / Canvas / List pickers: back
// chevron + "All Families › fruity › berry" trail; taps jump up the path.
export function AromaCrumbs({ path, onPop }: { path: string[]; onPop: (depth: number) => void }) {
  const { theme } = useTheme();
  const crumbs = [
    { label: 'All Families', depth: 0 },
    ...path.map((id, i) => ({ label: capFirst(getAromaNode(id)?.label ?? id), depth: i + 1 })),
  ];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 11, minHeight: 20 }}>
      {path.length ? (
        <Pressable accessibilityLabel="Back" onPress={() => onPop(path.length - 1)} hitSlop={8}>
          <Icon name="back" size={19} color={theme.accent} />
        </Pressable>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, flex: 1 }}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <View key={c.depth} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Pressable disabled={last} onPress={() => onPop(c.depth)}>
                <VText
                  surface="badge"
                  style={{
                    fontFamily: last ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium',
                    fontSize: 12.5,
                    color: last ? theme.ink : theme.accent,
                  }}
                >
                  {c.label}
                </VText>
              </Pressable>
              {!last ? (
                <VText surface="badge" style={{ fontSize: 12.5, color: theme.inkFaint }}>
                  ›
                </VText>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// The refine row's modifier SELECT — the Compare-toolbar select anatomy
// (ADR-0008): fixed 108pt width so a long display word can't resize its
// siblings, centered label that WEARS the pick, chevron pinned right, accent
// fill when set. Opens an anchored menu of the node's allowed modifiers
// (self-measuring, the AromaInput pattern). Disabled when there's no target
// or the node allows no modifiers.
export function ModifierSelectButton({
  a,
  m,
  onChange,
}: {
  a: string | null;
  m: string | null;
  onChange: (m: string | null) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { width: screenW } = useWindowDimensions();
  const btnRef = useRef<View | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [right, setRight] = useState(16);
  const fieldH = phone.surface('formControl').height(36);
  const allowedSet = a ? aromaAllowedModifiers(a) : null;
  const allowedMods = allowedSet ? AROMA_MODIFIERS.filter((mod) => allowedSet.has(mod.id)) : [];
  const off = !a || !allowedMods.length;
  const openMenu = () => {
    btnRef.current?.measureInWindow((x, y, _w, h) => {
      setRight(Math.max(12, screenW - x - 216));
      setAnchor({ top: y, bottom: y + h });
    });
  };
  return (
    <>
      <Pressable
        ref={btnRef}
        accessibilityRole="button"
        accessibilityLabel={a && m ? `Modifier — ${aromaModifierDisplay(a, m)}` : 'Add a modifier'}
        disabled={off}
        onPress={openMenu}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          height: fieldH,
          width: 108,
          paddingHorizontal: 12,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: m ? theme.accent : theme.rule,
          backgroundColor: m ? theme.accent : theme.surface,
          opacity: off ? 0.4 : pressed ? 0.6 : 1,
        })}
      >
        <VText
          numberOfLines={1}
          surface="badge"
          style={{ flex: 1, textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: m ? theme.accentInk : theme.inkSoft }}
        >
          {a && m ? capFirst(aromaModifierDisplay(a, m)) : 'Modifier'}
        </VText>
        <Icon name="chevrondown" size={13} color={m ? theme.accentInk : theme.inkSoft} />
      </Pressable>
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={right} minWidth={190}>
        <MenuItem
          label="None"
          active={!m}
          onPress={() => {
            onChange(null);
            setAnchor(null);
          }}
        />
        {allowedMods.map((mod) => (
          <MenuItem
            key={mod.id}
            label={a ? capFirst(aromaModifierDisplay(a, mod.id)) : mod.label}
            active={m === mod.id}
            onPress={() => {
              onChange(mod.id);
              setAnchor(null);
            }}
          />
        ))}
      </AnchoredMenu>
    </>
  );
}

// The refine row's Pronounced toggle — the double-chevron mark, glyph-only
// by default (the search row's width constraint; the word lives in the
// accessibility label). `withLabel` adds the written word where there's room;
// no current caller passes it (it was for the abandoned Rings corner control)
// — kept as a ready option for a future wide-refine surface. Outlined at
// rest, accent-filled when on (ADR-0008).
export function PronouncedToggle({
  on,
  onToggle,
  disabled,
  withLabel,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  withLabel?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const fieldH = phone.surface('formControl').height(36);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Pronounced"
      disabled={disabled}
      onPress={onToggle}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        height: fieldH,
        width: withLabel ? undefined : fieldH,
        paddingHorizontal: withLabel ? 12 : 0,
        gap: withLabel ? 5 : 0,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? theme.accent : theme.rule,
        backgroundColor: on ? theme.accent : theme.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name="pronounced" size={17} color={on ? theme.accentInk : theme.inkSoft} />
      {withLabel ? (
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: on ? theme.accentInk : theme.inkSoft }}>
          Pronounced
        </VText>
      ) : null}
    </Pressable>
  );
}

// The ONE refine row (rounds 6–8 of the search design, now shared by the
// search block and the Map/Canvas pickers): [modifier select | Pronounced
// glyph | Add]. Add is FIXED at a two-line height so a wrapping title can't
// change the row geometry; an exact already-added pair greys it to "Added"
// AND freezes the Pronounced toggle (no Update semantics — a toggled `p`
// against an added pair could never commit, so a live toggle was a dead
// control; review finding). The modifier select STAYS live when added:
// changing it retargets to a different, addable pair. All three disable
// until a target is armed.
export function RefineAddRow({
  a,
  m,
  p,
  added,
  onM,
  onP,
  onAdd,
}: {
  a: string | null;
  m: string | null;
  p: boolean;
  added: boolean;
  onM: (m: string | null) => void;
  onP: () => void;
  onAdd: () => void;
}) {
  const phone = usePhoneTokens();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <ModifierSelectButton a={a} m={m} onChange={onM} />
      <PronouncedToggle on={p && !added} onToggle={onP} disabled={!a || added} />
      <View style={{ flex: 1 }}>
        <Button
          block
          size="md"
          titleLines={2}
          style={{ height: phone.surface('button').height(54) }}
          disabled={!a || added}
          // No target yet → say what's missing, not a dead "Add" (Simon,
          // device pass).
          title={added ? 'Added' : a ? `Add ${capFirst(getAromaNode(a)?.label ?? '')}` : 'Pick an Aroma First'}
          onPress={onAdd}
        />
      </View>
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
