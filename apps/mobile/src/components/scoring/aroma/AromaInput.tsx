import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, View, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import { AROMA_SELECTION_CAP, searchAromas, type AromaSelection } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { SheetSearchField } from '@/components/moments/CompareBody';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useAromaOps, useTapOrDouble, AromaChip, RefineAddRow, SelectedChipsRow, canonicalPair, capFirst } from './parts';
import { SelectionSheet } from './SelectionSheet';
import { BrowseSheet } from './BrowseSheet';

// The Aromas block on the rating screen — search-first, the 02e·11 "S"
// variant (Simon's pick, 2026-07-10; the handoff is the VISUAL reference,
// semantics come from @verre/core / aroma-layer.md). Anatomy, top to bottom:
// section header · selected chips (capped, overflow behind "+N more" → the
// selection sheet; tapping a chip opens the refine POPUP) · [browse button |
// search field, the Compare toolbar/search skin] · while searching: the
// LAST-ADDED refine strip + suggestions.
//
// Search interaction (feedback rounds 2–5): tapping a suggestion FOCUSES it
// as the pending pick (a compound query like "dried fig" arrives with dried
// armed); a refine block — fixed-width modifier dropdown + Pronounced
// toggle + the ADD button — sits below the results, and Add commits the
// pair as a chip (a result tap only ever focuses — removal is the chip's ×).
// Everything stays visible with the keyboard open because focusing the
// field (a) renders a spacer below the section so the scroll ALWAYS has
// room, and (b) asks the screen for the minimal shift that fits the block
// above the keyboard (onRequestScroll).
// The OS keyboard-inset alone only bottom-aligns the field, hiding
// everything under it.
//
// Controlled: `value` is the canonical AromaSelection[] (the screen owns it,
// local-until-commit like score/flavors/notes); every mutation runs through
// the core gate inside useAromaOps.

// The displayed words of one search result, as a collision key: two results
// can read identically (the leaf "honey" under the "Honey" group — four such
// label twins in the taxonomy) and the colliding leaf then needs context.
const resultLabelKey = (r: ReturnType<typeof searchAromas>[number]) => `${r.node.label}|${r.modifierWord ?? ''}`.toLowerCase();

export function AromaInput({
  value,
  onChange,
  onRequestScroll,
}: {
  value: AromaSelection[];
  onChange: (v: AromaSelection[]) => void;
  // Called when the field focuses (and again whenever the block's rendered
  // height changes), with the search row's window-Y and the MEASURED height
  // below that point (field + suggestions + refine row + cap hint) — the
  // screen scrolls the minimal shift that fits the block above the keyboard.
  onRequestScroll?: (rowTopInWindow: number, blockBelow: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { height: screenH } = useWindowDimensions();
  const ops = useAromaOps(value, onChange);
  const [query, setQuery] = useState('');
  const [fieldFocused, setFieldFocused] = useState(false);
  // Pending pick from the results — the refine block's target; `m` seeds
  // from the result and the rail edits it before Add commits. Pronounced is
  // likewise pending until Add. `key` pins the tapped RESULT ROW: highlight
  // identity, so a modifier edit on the button doesn't drop it (feedback)
  // and two rows sharing a node (canonical rewrites can produce that) never
  // co-highlight (review finding).
  const [focus, setFocus] = useState<{ a: string; m: string | null; key: string } | null>(null);
  const [pendP, setPendP] = useState(false);
  const [selOpen, setSelOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  // The ⓘ explainer by the hint line (the structure panel's pattern).
  const [helpAnchor, setHelpAnchor] = useState<MenuAnchor | null>(null);
  const searchRowRef = useRef<View | null>(null);
  const tap = useTapOrDouble();

  const q = query.trim();
  const results = useMemo(() => (q ? searchAromas(q) : []), [q]);
  // Which displayed labels appear more than once in this result list — those
  // leaves render their ancestor context (review finding: core's `context`
  // was otherwise discarded and colliding rows read as duplicates).
  const dupLabels = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const r of results) {
      const k = resultLabelKey(r);
      if (seen.has(k)) dup.add(k);
      else seen.add(k);
    }
    return dup;
  }, [results]);
  // "Already selected" must compare the CANONICAL pair — ops.add rewrites a
  // promoted composite (grape+dried → raisin), so a raw {a, m} check would
  // show a live Add + fire the success haptic on a pair the gate dedupes
  // into an existing selection (review finding; mirrors usePendingAdd).
  const canonFocus = focus ? canonicalPair(focus.a, focus.m) : null;
  const focusedPairSelected = !!canonFocus && value.some((s) => s.a === canonFocus.a && s.m === canonFocus.m);
  // Cap-rejection hint (the spec bans a live COUNTER, not a rejection
  // message): shown when an add bounces off the 30 cap, cleared once the
  // situation changes (new query, or a removal makes room).
  const [capHit, setCapHit] = useState(false);
  useEffect(() => {
    if (value.length < AROMA_SELECTION_CAP) setCapHit(false);
  }, [value.length]);
  const commitAdd = () => {
    if (!focus) return;
    const ok = ops.add(pendP ? { a: focus.a, m: focus.m, p: true } : { a: focus.a, m: focus.m });
    if (!ok) {
      // Gate rejected (the 30 cap) — honest warning tick + a visible hint,
      // keep the pick armed, no flash: never celebrate an add that didn't land.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setCapHit(true);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); // acknowledged (no-op in Sim)
    // (The chips block detects the fresh pair itself and flashes it.)
    setFocus(null);
    setPendP(false);
  };

  // Scroll the block under the header when search engages. Runs on focus
  // (the spacer below renders the same commit, so the range exists), again
  // after the keyboard animation in case the OS's keep-field-visible
  // adjustment moved things meanwhile, and whenever the rendered block
  // CHANGES height (typing grows/shrinks the results).
  // The block the scroll must fit above the keyboard = search row + the
  // MEASURED height of everything below it (results / no-match line / refine
  // row / cap hint, via onLayout — a flat estimate over-scrolled blank
  // queries and under-scrolled large text and cap states; review finding).
  // The anchored modifier menu is a Modal overlay, so it never counts.
  const fieldH = phone.surface('formControl').height(36);
  const [belowH, setBelowH] = useState(0);
  useEffect(() => {
    if (!fieldFocused) return;
    const measure = () => searchRowRef.current?.measureInWindow((_x, y) => onRequestScroll?.(y, fieldH + belowH));
    const raf = requestAnimationFrame(measure);
    const late = setTimeout(measure, 350);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldFocused, belowH]);

  const searching = fieldFocused || q.length > 0;

  return (
    <View>
      {/* section header — same weight/rhythm as the Structure Profile row,
          with the one-line hint + ⓘ explainer the structure panel also has. */}
      <View style={{ paddingTop: 15, paddingBottom: 11, gap: 4 }}>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>Aromas</VText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* flexShrink so long Dynamic Type wraps instead of pushing the ⓘ
              off-screen (Codex review, PR #77) */}
          <VText variant="small" color="inkSoft" style={{ flexShrink: 1 }}>
            What do you perceive? Add any aromas you find.
          </VText>
          <AnchorButton icon="info" iconColor={theme.inkSoft} accessibilityLabel="How Aromas Work" onOpen={setHelpAnchor} />
        </View>
      </View>
      <AnchoredMenu anchor={helpAnchor} onClose={() => setHelpAnchor(null)} right={16} minWidth={280}>
        <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 12, maxWidth: 300 }}>
          <VText variant="small" style={{ color: theme.ink, fontFamily: 'InstrumentSans_600SemiBold' }}>
            How Aromas Work
          </VText>
          <VText variant="small" style={{ color: theme.ink }}>
            Find an aroma and add it. Modifiers like dried or jammy refine it.
          </VText>
          {/* definition block — glyph + term as their own line, body flush
              left like the other paragraphs (a mid-paragraph glyph indented
              the whole block and read as chaos on device). */}
          <View style={{ gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name="pronounced" size={15} color={theme.accent} />
              <VText variant="small" style={{ color: theme.ink, fontFamily: 'InstrumentSans_600SemiBold' }}>
                Pronounced
              </VText>
            </View>
            <VText variant="small" style={{ color: theme.ink }}>
              Use it when an aroma clearly stands out from the rest. You can also double-tap an aroma to set it.
            </VText>
          </View>
          <VText variant="small" style={{ color: theme.ink }}>
            Tap an added aroma to edit it.{'\n'}× removes it.
          </VText>
        </View>
      </AnchoredMenu>
      {/* selected chips, pinned above the search row — THE shared block
          (chips + "+N more" + refine popup + add flash), one behaviour with
          the browse sheet. */}
      {value.length ? (
        <View style={{ marginBottom: 12 }}>
          <SelectedChipsRow ops={ops} onOverflow={() => { Keyboard.dismiss(); setSelOpen(true); }} />
        </View>
      ) : null}
      {/* [browse | search] row — the Compare toolbar skin: 36pt chip button +
          the shared SheetSearchField pill (ONE search skin app-wide). */}
      <View ref={searchRowRef} collapsable={false} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Browse Aromas"
          onPress={() => {
            // A sheet opened over a live keyboard inherits the screen's
            // keyboard-inset scroll state with no field to type into — drop
            // the keyboard first (review finding).
            Keyboard.dismiss();
            setBrowseOpen(true);
          }}
          hitSlop={{ top: 4, bottom: 4 }}
          style={({ pressed }) => ({
            height: fieldH,
            paddingHorizontal: 12,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: theme.rule,
            backgroundColor: theme.surface,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="grid" size={16} color={browseOpen ? theme.accent : theme.inkSoft} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <SheetSearchField
            value={query}
            onChangeText={(t) => {
              setQuery(t);
              setFocus(null);
              setPendP(false);
            }}
            placeholder="Search all aromas…"
            onFocus={() => setFieldFocused(true)}
            onBlur={() => setFieldFocused(false)}
          />
        </View>
      </View>
      {/* Everything under the search row renders inside ONE measured wrapper
          so the keyboard fit above works with the real rendered height. */}
      <View onLayout={(e) => { const h = Math.ceil(e.nativeEvent.layout.height); setBelowH((prev) => (prev === h ? prev : h)); }}>
        {/* suggestions — tap to focus (arms the refine slot below); tapping an
            already-added one removes it; added pairs show at the deeper tint. */}
        {q ? (
          results.length ? (
            <ScrollView nestedScrollEnabled style={{ maxHeight: 150, marginTop: 10 }} keyboardShouldPersistTaps="handled">
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingBottom: 2 }}>
                {results.map((r) => {
                  const id = r.node.tier === 'leaf' ? r.node.leaf!.id : r.node.tier === 'subfamily' ? r.node.subfamily!.id : r.node.family.id;
                  const rowKey = `${id}|${r.m ?? ''}`;
                  // Focus pins the tapped ROW (not the node): a modifier edit
                  // on the button must not drop the highlight (feedback), and
                  // a sibling row sharing the node via a canonical rewrite
                  // must not co-highlight (review finding).
                  const isFocus = focus?.key === rowKey;
                  // Leaf context only where the displayed words collide with
                  // another result (honey the leaf vs Honey the group): the
                  // nearest ancestor that actually differs.
                  const leafCtx =
                    r.node.tier === 'leaf' && dupLabels.has(resultLabelKey(r))
                      ? [...r.context].reverse().find((c) => c.toLowerCase() !== r.node.label.toLowerCase())
                      : undefined;
                  return (
                    <AromaChip
                      key={rowKey}
                      a={id}
                      m={r.m}
                      // Highlight + border are TRANSIENT add-process state only
                      // (feedback): results never show added/pronounced marks —
                      // that lives on the selected chips above. ARMED keeps its
                      // resting colours; the armed signal is every OTHER result
                      // muting (Simon's 2026-07-12 ruling — supersedes the
                      // earlier solid focus flip). Border = pending Pronounced.
                      muted={!!focus && !isFocus}
                      pronounced={isFocus && pendP}
                      sub={r.node.tier === 'family' ? 'family' : r.node.tier === 'subfamily' ? 'group' : leafCtx ? capFirst(leafCtx) : undefined}
                      // single = focus toggle — for ADDED pairs too (you may
                      // want the same aroma with a second modifier; removal is
                      // the chip's ×, never a result tap). double = focus the
                      // row and ARM pending Pronounced. In immediate mode the
                      // first tap's `single` already ran (clearing pendP), so
                      // `double` unconditionally SETS — the old `isFocus ? !p`
                      // toggle was timing-dependent dead code (the re-render
                      // between taps made isFocus false; review finding), and
                      // the help copy says double-tap "to set it". Disarm is
                      // the PronouncedToggle in the refine row.
                      onPress={() =>
                        tap(
                          `res:${rowKey}`,
                          () => {
                            setFocus(isFocus ? null : { a: id, m: r.m, key: rowKey });
                            setPendP(false);
                          },
                          () => {
                            setFocus({ a: id, m: r.m, key: rowKey });
                            setPendP(true);
                          },
                        )
                      }
                    />
                  );
                })}
              </View>
            </ScrollView>
          ) : (
            <VText variant="small" color="inkFaint" style={{ marginTop: 12 }}>
              No aromas match “{q}”.
            </VText>
          )
        ) : null}
        {/* refine row — BELOW the results, ONE stable row for the whole search
            (rounds 6–8): [modifier select | Pronounced glyph | Add]. Now the
            SHARED RefineAddRow (Map/Canvas/Rings all wear the same anatomy;
            List hosts it in the sheet footer — Simon's device ruling). All
            three disable until a result is focused; nothing pops or shifts. */}
        {q ? (
          <View style={{ marginTop: 12 }}>
            <RefineAddRow
              a={focus?.a ?? null}
              m={focus?.m ?? null}
              p={pendP}
              added={focusedPairSelected}
              onM={(m) => {
                // Retargeting AWAY from an added pair drops pending Pronounced:
                // the toggle rendered off+disabled there (`p && !added`), so a
                // surviving true would silently arm the next addable pair.
                if (focusedPairSelected) setPendP(false);
                setFocus((f) => (f ? { ...f, m } : f));
              }}
              onP={() => setPendP((p) => !p)}
              onAdd={commitAdd}
            />
          </View>
        ) : null}
        {/* cap-rejection hint — under the refine row, cleared once a removal
            makes room (the spec bans a counter, not a rejection message). */}
        {q && capHit ? (
          <VText variant="small" style={{ marginTop: 8, textAlign: 'center', color: theme.critical }}>
            Limit reached — an impression holds up to {AROMA_SELECTION_CAP} aromas.
          </VText>
        ) : null}
      </View>
      {/* Keyboard-room spacer: while searching, guarantees the screen can
          scroll this block to the TOP of the viewport even when the section
          sits at the end of the content — without it the scroll clamps and
          the results stay under the keyboard (feedback round 4). Sized to a
          keyboard-ish share of the screen; collapses when search ends. */}
      {searching ? <View style={{ height: Math.round(screenH * 0.45) }} /> : null}
      <SelectionSheet open={selOpen} onClose={() => setSelOpen(false)} ops={ops} />
      <BrowseSheet open={browseOpen} onClose={() => setBrowseOpen(false)} ops={ops} />
    </View>
  );
}
