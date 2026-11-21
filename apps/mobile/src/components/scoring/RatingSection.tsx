import type { AxisKind } from '@verre/core';
import { View } from 'react-native';
import type { AromaSelection } from '@verre/core';
import { AromaInput } from '@/components/scoring/aroma/AromaInput';
import { IntensityScaleInfo } from '@/components/scoring/IntensityScaleInfo';
import { ScoreInput } from '@/components/scoring/ScoreInput';
import { StructureInput } from '@/components/scoring/StructureInput';
import { NotesField } from '@/components/moments/momentForm';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

// THE rating block — score · note · structure · aromas — shared verbatim by
// the moment impression screen (02e) and the standalone check-in rate stage
// (Simon's ruling, 2026-07-12: one component so a future ordering/copy/
// behaviour change lands on BOTH surfaces; the impression's anatomy is the
// spec — its order was the explicit 2026-07-10 "note between score and
// structure" ruling, and the standalone flow has no mock of its own).
//
// Controlled throughout: the screen owns every value (local-until-commit on
// the impression, draft-backed on the check-in). Structure is ALWAYS OPEN
// (Simon 2026-07-17 — supersedes the adaptive fold + its engagement-seeded
// open state). The ⓘ intensity scale is `IntensityScaleInfo` (shared with
// Filter for Structure).
export function RatingSection({
  kind,
  score,
  onScore,
  notes,
  onNotes,
  flavors,
  onFlavors,
  aromas,
  onAromas,
  onRequestAromaScroll,
}: {
  // The bottle's kind for the structure axes (`{ sparkling }`: Bubbles; null =
  // the base wine set). NOT masked on blind (colour and sparkling stay on a
  // blind row): a taster perceives fizz / tannin / body blind.
  kind: AxisKind;
  score: number;
  onScore: (v: number) => void;
  notes: string;
  onNotes: (s: string) => void;
  flavors: Record<string, number>;
  onFlavors: (v: Record<string, number>) => void;
  aromas: AromaSelection[];
  onAromas: (v: AromaSelection[]) => void;
  // Forwarded to AromaInput — see useAromaSearchScroll for the screen half.
  onRequestAromaScroll?: (rowTopInWindow: number, blockBelow: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
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
      {/* "Structure profile" — ALWAYS OPEN (Simon 2026-07-17; the adaptive
          fold + chevron are gone). paddingTop 24 (not the symmetric 16):
          breathing room below the separator — 16 felt crammed once the rule
          moved under the note (Simon, 2026-07-12). Title lost its "Add "
          prefix the same round. */}
      <View style={{ paddingTop: 24, paddingBottom: 16 }}>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
          Structure Profile
        </VText>
      </View>
      <View style={{ gap: 14 }}>
        {/* Short "what to do" line under the title, with the ⓘ intensity-scale
            bubble at the END of the line. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -10 }}>
          <VText variant="small" color="inkSoft">
            Set each track to the intensity you perceive.
          </VText>
          <IntensityScaleInfo />
        </View>
        {/* .filltrack per-attribute intensity grid — structure axes for this
            drink's style, colour from the active theme. */}
        <StructureInput kind={kind} value={flavors} onChange={onFlavors} />
      </View>
      {/* Aromas — the descriptor layer (02e·11 search-first block). Always
          visible, blind included: like structure, aromas are the taster's own
          perception and never identify the wine. */}
      <AromaInput value={aromas} onChange={onAromas} onRequestScroll={onRequestAromaScroll} />
    </View>
  );
}
