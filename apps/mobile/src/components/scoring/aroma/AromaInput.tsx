import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import { AROMA_MODIFIERS, aromaAllowedModifiers, aromaModifierDisplay, getAromaNode, searchAromas, type AromaSelection } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { Button } from '@/components/ui/Button';
import { SheetSearchField } from '@/components/moments/CompareBody';
import { AnchoredMenu, AnchorButton, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { usePhoneTokens } from '@/lib/layout';
import { motion, useTheme } from '@/theme';
import { useAromaOps, useTapOrDouble, AromaChip, ModifierPopup, canonicalPair, capFirst, displayOrder } from './parts';
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

// Overflow cap for the inline chips row (~2 lines; the mock's MAX=5).
const CHIP_CAP = 5;

// The "it landed HERE" cue on the chip a fresh Add produced (or the "+N
// more" pill when the ordering files it into the overflow): a LIGHT-UP — an
// accent veil flashes over the chip and fades (device feedback: a bare
// scale pulse read as nothing), plus a slight lift. Motion tokens only.
function FlashPulse({ on, children }: { on: boolean; children: React.ReactNode }) {
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

export function AromaInput({
  value,
  onChange,
  onRequestScroll,
}: {
  value: AromaSelection[];
  onChange: (v: AromaSelection[]) => void;
  // Called when the field focuses, with the search row's window-Y and the
  // search block's rendered height below that point (field + suggestions +
  // refine row, Dynamic-Type-scaled) — the screen scrolls the minimal shift
  // that fits the block above the keyboard.
  onRequestScroll?: (rowTopInWindow: number, blockBelow: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { height: screenH, width: screenW } = useWindowDimensions();
  const ops = useAromaOps(value, onChange);
  const [query, setQuery] = useState('');
  const [fieldFocused, setFieldFocused] = useState(false);
  // Pending pick from the results — the refine block's target; `m` seeds
  // from the result and the rail edits it before Add commits. Pronounced is
  // likewise pending until Add.
  const [focus, setFocus] = useState<{ a: string; m: string | null } | null>(null);
  const [pendP, setPendP] = useState(false);
  const [selOpen, setSelOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  // Chip refine popup (tap a selected chip) — anchored at the tapped chip.
  const [popup, setPopup] = useState<{ a: string; m: string | null; anchor: MenuAnchor; right?: number } | null>(null);
  // The ⓘ explainer by the hint line (the structure panel's pattern).
  const [helpAnchor, setHelpAnchor] = useState<MenuAnchor | null>(null);
  const chipRefs = useRef<Record<string, View | null>>({});
  const searchRowRef = useRef<View | null>(null);
  const tap = useTapOrDouble();
  // Modifier menu (the refine row's button) — anchored like Compare's sort
  // menu: right edge placed a panel-width from the button's left.
  const modBtnRef = useRef<View | null>(null);
  const [modMenuAnchor, setModMenuAnchor] = useState<MenuAnchor | null>(null);
  const [modMenuRight, setModMenuRight] = useState(16);
  const openModMenu = () => {
    modBtnRef.current?.measureInWindow((x, y, _w, h) => {
      setModMenuRight(Math.max(12, screenW - x - 216));
      setModMenuAnchor({ top: y, bottom: y + h });
    });
  };

  const q = query.trim();
  const results = useMemo(() => (q ? searchAromas(q) : []), [q]);
  const allowedSet = focus ? aromaAllowedModifiers(focus.a) : null;
  const allowedMods = allowedSet ? AROMA_MODIFIERS.filter((mod) => allowedSet.has(mod.id)) : [];
  const focusedPairSelected = !!focus && value.some((s) => s.a === focus.a && s.m === focus.m);
  // The freshly added chip's key (canonical — a promoted composite lands as
  // its leaf) — drives the flash cue; cleared after the pulse.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 800);
    return () => clearTimeout(t);
  }, [flash]);
  const commitAdd = () => {
    if (!focus) return;
    ops.add(pendP ? { a: focus.a, m: focus.m, p: true } : { a: focus.a, m: focus.m });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); // acknowledged (no-op in Sim)
    const canon = canonicalPair(focus.a, focus.m);
    setFlash(`${canon.a}|${canon.m ?? ''}`);
    setFocus(null);
    setPendP(false);
  };

  // Scroll the block under the header when search engages. Runs on focus
  // (the spacer below renders the same commit, so the range exists), then
  // again after the keyboard animation in case the OS's keep-field-visible
  // adjustment moved things meanwhile.
  // The block the scroll must fit above the keyboard, from the SAME surface
  // math the pieces render with (a flat constant under-measured and ignored
  // Dynamic Type — review finding): search row + suggestions box + the
  // fixed two-line Add row, plus their margins.
  const blockBelow =
    phone.surface('formControl').height(36) + 10 + 150 + 12 + Math.max(phone.surface('formControl').height(36), phone.surface('button').height(54)) + 8;
  useEffect(() => {
    if (!fieldFocused) return;
    const measure = () => searchRowRef.current?.measureInWindow((_x, y) => onRequestScroll?.(y, blockBelow));
    const raf = requestAnimationFrame(measure);
    const late = setTimeout(measure, 350);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldFocused]);

  const openPopup = (sel: { a: string; m: string | null }) => {
    const key = `${sel.a}|${sel.m ?? ''}`;
    chipRefs.current[key]?.measureInWindow((x, y, _w, h) => {
      // Panel sits by the tapped chip (compare-sort placement), not full-width.
      setPopup({ a: sel.a, m: sel.m, anchor: { top: y, bottom: y + h }, right: Math.max(12, screenW - x - 280) });
    });
  };

  const overflow = value.length - CHIP_CAP;
  // STABLE slice of the display order (pronounced → family → insertion) — an
  // earlier "newest stays visible" eviction hack fought the family
  // clustering and made every add reshuffle the row (device feedback:
  // chaotic). An add that files into the overflow announces itself via the
  // pill's flash instead of an eviction.
  const ordered = displayOrder(value);
  const visibleChips = overflow > 0 ? ordered.slice(0, CHIP_CAP) : ordered;
  const fieldH = phone.surface('formControl').height(36);
  const searching = fieldFocused || q.length > 0;

  return (
    <View>
      {/* section header — same weight/rhythm as the Structure Profile row,
          with the one-line hint + ⓘ explainer the structure panel also has. */}
      <View style={{ paddingTop: 15, paddingBottom: 11, gap: 4 }}>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>Aromas</VText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <VText variant="small" color="inkSoft">
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
      {/* selected chips, pinned above the search row; tap = refine popup */}
      {value.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {visibleChips.map((sel) => {
            const key = `${sel.a}|${sel.m ?? ''}`;
            return (
              <View key={key} ref={(n) => { chipRefs.current[key] = n; }} collapsable={false}>
                <FlashPulse on={flash === key}>
                  <AromaChip
                    a={sel.a}
                    m={sel.m}
                    pronounced={!!sel.p}
                    // single tap = refine popup (delayed past the double window —
                    // an instant Modal would swallow the second tap); double tap
                    // = toggle Pronounced directly (the mock gesture, restored).
                    onPress={() =>
                      tap(`chip:${key}`, () => openPopup(sel), () => ops.togglePronounced(sel.a, sel.m), 'delayed')
                    }
                    onRemove={() => {
                      delete chipRefs.current[key];
                      ops.removePair(sel.a, sel.m);
                    }}
                  />
                </FlashPulse>
              </View>
            );
          })}
          {overflow > 0 ? (
            // The pill pulses when the fresh add filed into the overflow.
            <FlashPulse on={!!flash && !visibleChips.some((sel) => `${sel.a}|${sel.m ?? ''}` === flash)}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${overflow} more aromas`}
                onPress={() => setSelOpen(true)}
                style={{
                  justifyContent: 'center',
                  paddingVertical: 6, // no border — visually matches the chips' 4.5+1.5
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  backgroundColor: theme.surface,
                }}
              >
                <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.inkSoft }}>
                  +{overflow} more
                </VText>
              </Pressable>
            </FlashPulse>
          ) : null}
        </View>
      ) : null}
      {/* [browse | search] row — the Compare toolbar skin: 36pt chip button +
          the shared SheetSearchField pill (ONE search skin app-wide). */}
      <View ref={searchRowRef} collapsable={false} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Browse Aromas"
          onPress={() => setBrowseOpen(true)}
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
      {/* suggestions — tap to focus (arms the refine slot below); tapping an
          already-added one removes it; added pairs show at the deeper tint. */}
      {q ? (
        results.length ? (
          <ScrollView nestedScrollEnabled style={{ maxHeight: 150, marginTop: 10 }} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingBottom: 2 }}>
              {results.map((r) => {
                const id = r.node.tier === 'leaf' ? r.node.leaf!.id : r.node.tier === 'subfamily' ? r.node.subfamily!.id : r.node.family.id;
                // Focus matches on the NODE: picking a modifier on the button
                // changes focus.m, and the highlighted result must not drop
                // its highlight over that (feedback).
                const isFocus = focus?.a === id;
                return (
                  <AromaChip
                    key={`${id}|${r.m ?? ''}`}
                    a={id}
                    m={r.m}
                    // Highlight + border are TRANSIENT add-process state only
                    // (feedback): results never show added/pronounced marks —
                    // that lives on the selected chips above. Deep tint =
                    // currently focused; border = pending Pronounced.
                    focused={isFocus}
                    pronounced={isFocus && pendP}
                    sub={r.node.tier === 'family' ? 'family' : r.node.tier === 'subfamily' ? 'group' : undefined}
                    // single = focus toggle — for ADDED pairs too (you may
                    // want the same aroma with a second modifier; removal is
                    // the chip's ×, never a result tap). double = arm the
                    // pending Pronounced flag.
                    onPress={() =>
                      tap(
                        `res:${id}|${r.m ?? ''}`,
                        () => {
                          setFocus(isFocus ? null : { a: id, m: r.m });
                          setPendP(false);
                        },
                        () => {
                          setFocus({ a: id, m: r.m });
                          setPendP((p) => (isFocus ? !p : true));
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
          (rounds 6–8): [modifier button | Pronounced switch | Add]. The
          modifier button is the Compare-toolbar pattern — it opens an
          anchored menu of the node's allowed modifiers and then WEARS the
          pick ("Jammy" instead of "Modifier"). All three disable until a
          result is focused; nothing pops or shifts. */}
      {q ? (
        // Chips center on Add's midline; Add is FIXED at a two-line height so
        // a wrapping title can't change the row geometry (no jump, no sink).
        <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable
            ref={modBtnRef}
            accessibilityRole="button"
            accessibilityLabel={focus?.m ? `Modifier — ${aromaModifierDisplay(focus.a, focus.m)}` : 'Add a modifier'}
            disabled={!focus || !allowedMods.length}
            onPress={openModMenu}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              height: fieldH,
              // FIXED width — a long display word ("Overripe") must not
              // resize the siblings; the label truncates instead.
              width: 108,
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              // Active = the Pronounced chip's on-state (accent fill).
              borderColor: focus?.m ? theme.accent : theme.rule,
              backgroundColor: focus?.m ? theme.accent : theme.surface,
              opacity: !focus || !allowedMods.length ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            {/* label centers in the flexing slot, chevron stays pinned right */}
            <VText
              numberOfLines={1}
              surface="badge"
              style={{ flex: 1, textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: focus?.m ? theme.accentInk : theme.inkSoft }}
            >
              {focus?.m ? capFirst(aromaModifierDisplay(focus.a, focus.m)) : 'Modifier'}
            </VText>
            <Icon name="chevrondown" size={13} color={focus?.m ? theme.accentInk : theme.inkSoft} />
          </Pressable>
          {/* Pronounced = a glyph-only toggle chip (the double-chevron mark,
              Simon's glyph — width was the constraint; the word lives in the
              accessibility label): outlined at rest, accent-filled when on. */}
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: pendP }}
            accessibilityLabel="Pronounced"
            disabled={!focus}
            onPress={() => setPendP((p) => !p)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => ({
              height: fieldH,
              width: fieldH,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: pendP ? theme.accent : theme.rule,
              backgroundColor: pendP ? theme.accent : theme.surface,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !focus ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            <Icon name="pronounced" size={17} color={pendP ? theme.accentInk : theme.inkSoft} />
          </Pressable>
          <View style={{ flex: 1 }}>
            {/* An exact (aroma, modifier) match greys out — no Update
                semantics; changing the modifier re-arms it as a new Add.
                Label carries the AROMA name (never the modifier — that's on
                its own button). */}
            <Button
              block
              size="md"
              titleLines={2}
              style={{ height: phone.surface('button').height(54) }}
              disabled={!focus || focusedPairSelected}
              title={focusedPairSelected ? 'Added' : focus ? `Add ${capFirst(getAromaNode(focus.a)?.label ?? '')}` : 'Add'}
              onPress={commitAdd}
            />
          </View>
          <AnchoredMenu anchor={modMenuAnchor} onClose={() => setModMenuAnchor(null)} right={modMenuRight} minWidth={190}>
            <MenuItem
              label="None"
              active={!focus?.m}
              onPress={() => {
                if (focus) setFocus({ a: focus.a, m: null });
                setModMenuAnchor(null);
              }}
            />
            {allowedMods.map((mod) => (
              <MenuItem
                key={mod.id}
                label={focus ? capFirst(aromaModifierDisplay(focus.a, mod.id)) : mod.label}
                active={focus?.m === mod.id}
                onPress={() => {
                  if (focus) setFocus({ a: focus.a, m: mod.id });
                  setModMenuAnchor(null);
                }}
              />
            ))}
          </AnchoredMenu>
        </View>
      ) : null}
      {/* Keyboard-room spacer: while searching, guarantees the screen can
          scroll this block to the TOP of the viewport even when the section
          sits at the end of the content — without it the scroll clamps and
          the results stay under the keyboard (feedback round 4). Sized to a
          keyboard-ish share of the screen; collapses when search ends. */}
      {searching ? <View style={{ height: Math.round(screenH * 0.45) }} /> : null}
      <ModifierPopup
        target={popup}
        onClose={() => setPopup(null)}
        ops={ops}
        onTargetChange={(pair) => setPopup((p) => (p ? { ...p, ...pair } : p))}
      />
      <SelectionSheet open={selOpen} onClose={() => setSelOpen(false)} ops={ops} />
      <BrowseSheet open={browseOpen} onClose={() => setBrowseOpen(false)} ops={ops} />
    </View>
  );
}
