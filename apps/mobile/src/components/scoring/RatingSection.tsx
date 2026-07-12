import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { AromaSelection } from '@verre/core';
import { AromaInput } from '@/components/scoring/aroma/AromaInput';
import { ScoreInput } from '@/components/scoring/ScoreInput';
import { StructureInput } from '@/components/scoring/StructureInput';
import { NotesField } from '@/components/moments/momentForm';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { INTENSITY } from '@/lib/scoreWords';
import { useTheme } from '@/theme';

// THE rating block — score · note · adaptive structure fold · aromas — shared
// verbatim by the moment impression screen (02e) and the standalone check-in
// rate stage (Simon's ruling, 2026-07-12: one component so a future ordering/
// copy/behaviour change lands on BOTH surfaces; the impression's anatomy is
// the spec — its order was the explicit 2026-07-10 "note between score and
// structure" ruling, and the standalone flow has no mock of its own).
//
// Controlled throughout: the screen owns every value (local-until-commit on
// the impression, draft-backed on the check-in). The structure fold is
// controlled too — the impression seeds it open on structure engagement when
// a wine's stored rating arrives, which the component can't time itself.
// Only the ⓘ intensity-reference anchor is internal state.
export function RatingSection({
  style,
  score,
  onScore,
  notes,
  onNotes,
  flavors,
  onFlavors,
  aromas,
  onAromas,
  structureOpen,
  onToggleStructure,
  onRequestAromaScroll,
}: {
  // Structure-axes style for this drink (wines: red/white/spark/rose/nonalc;
  // null = the base wine set). NOT masked on blind — a taster perceives
  // fizz/tannin/body blind, so structure stays rateable while identity hides.
  style: string | null;
  score: number;
  onScore: (v: number) => void;
  notes: string;
  onNotes: (s: string) => void;
  flavors: Record<string, number>;
  onFlavors: (v: Record<string, number>) => void;
  aromas: AromaSelection[];
  onAromas: (v: AromaSelection[]) => void;
  structureOpen: boolean;
  onToggleStructure: () => void;
  // Forwarded to AromaInput — see useAromaSearchScroll for the screen half.
  onRequestAromaScroll?: (rowTopInWindow: number, blockBelow: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const [infoAnchor, setInfoAnchor] = useState<MenuAnchor | null>(null);
  return (
    <View>
      <ScoreInput value={score} onChange={onScore} />
      {/* note — tucked right under the score, NO title (Simon, 2026-07-12 —
          the placeholder carries the affordance), and the .ir-rate separator
          rule moved from ScoreInput to BELOW the note so score + note read as
          one block. The shared NotesField caps its growth (~8 lines) then
          scrolls internally. */}
      {/* The note is NOT for aroma descriptors (that's the Aromas layer
          below) — it's the taster's own thoughts/feelings on the impression,
          effectively their public CAPTION on the feed post (Simon,
          2026-07-12). The placeholder invites a comment, never a tasting
          vocabulary. */}
      <View style={{ marginTop: 6, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
        <NotesField placeholder="Say what the stars can’t." value={notes} onChange={onNotes} />
      </View>
      {/* .ir-detail-toggle + panel — the adaptive "Structure profile". The ⓘ
          (open only) sits as a SIBLING of the toggle Pressable, not nested —
          nested Pressables fight for the touch responder. It opens the
          intensity-scale reference (numbered 0–5). */}
      {/* paddingTop 24 (not the symmetric 16): breathing room below the
          separator — 16 felt crammed once the rule moved under the note
          (Simon, 2026-07-12). Title lost its "Add " prefix the same round. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 24, paddingBottom: 16 }}>
        <Pressable
          onPress={onToggleStructure}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
        >
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
            Structure Profile
          </VText>
        </Pressable>
        <Pressable
          onPress={onToggleStructure}
          hitSlop={8}
          style={{ marginLeft: 4, transform: [{ rotate: structureOpen ? '180deg' : '0deg' }] }}
        >
          <Icon name="chevron-down" size={18} color={theme.inkSoft} />
        </Pressable>
      </View>
      {structureOpen ? (
        <View style={{ gap: 14 }}>
          {/* Short "what to do" line under the title (always visible when open),
              with the ⓘ intensity-scale bubble at the END of the line. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -10 }}>
            <VText variant="small" color="inkSoft">
              Set each track to the intensity you perceive.
            </VText>
            <AnchorButton
              icon="info"
              iconColor={theme.inkSoft}
              accessibilityLabel="Intensity scale"
              onOpen={setInfoAnchor}
            />
          </View>
          {/* .filltrack per-attribute intensity grid — structure axes for this
              drink's style, colour from the active theme. */}
          <StructureInput style={style} value={flavors} onChange={onFlavors} />
        </View>
      ) : null}
      {/* Aromas — the descriptor layer (02e·11 search-first block). Always
          visible, blind included: like structure, aromas are the taster's own
          perception and never identify the wine. */}
      <AromaInput value={aromas} onChange={onAromas} onRequestScroll={onRequestAromaScroll} />
      {/* Intensity-scale reference — the numbered 0–5 levels, one per row.
          Purely the scale legend the ⓘ opens (a Modal — render position is
          irrelevant, so it lives here with its trigger). */}
      <AnchoredMenu anchor={infoAnchor} onClose={() => setInfoAnchor(null)} right={16} minWidth={180}>
        <View style={{ paddingHorizontal: 10, paddingVertical: 6, gap: 5 }}>
          <VText variant="small" style={{ color: theme.ink, fontFamily: 'InstrumentSans_600SemiBold', marginBottom: 3 }}>
            Perceived Intensity
          </VText>
          {INTENSITY.map((word, i) => (
            <View key={word} style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <VText
                variant="small"
                style={{ color: theme.accent, fontFamily: 'InstrumentSans_600SemiBold', width: 18, fontVariant: ['tabular-nums'] }}
              >
                {i}
              </VText>
              <VText variant="small" style={{ color: theme.ink }}>{word}</VText>
            </View>
          ))}
        </View>
      </AnchoredMenu>
    </View>
  );
}
