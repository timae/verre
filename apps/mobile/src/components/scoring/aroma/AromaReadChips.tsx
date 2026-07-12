import { View } from 'react-native';
import type { AromaSelection } from '@verre/core';
import { VText } from '@/components/ui/VText';
import { AromaChip, displayOrder } from './parts';

// Read-only aroma chips — THE native display surface for someone's stored
// selections (feed impression detail now; further native read surfaces reuse
// this; the web has its own twin, components/ui/AromaReadChips.tsx — no
// shared RN/web layer). Renders the canonical badge (AromaChip — family tint,
// aroma-then-modifier words, Pronounced border) in the shared display order
// (pronounced first, then grouped by family — aroma-layer.md §7). No input,
// no refine, no ×: mutations only ever happen through AromaInput.
export function AromaReadChips({
  aromas,
  lead,
}: {
  aromas: AromaSelection[] | undefined;
  // Optional lead word, the TastesLike pattern ("Aromas").
  lead?: string;
}) {
  if (!aromas?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}>
      {lead ? (
        <VText variant="caption" color="inkSoft" style={{ marginRight: 2 }}>
          {lead}
        </VText>
      ) : null}
      {displayOrder(aromas).map((sel) => (
        <AromaChip key={`${sel.a}|${sel.m ?? ''}`} a={sel.a} m={sel.m} pronounced={!!sel.p} />
      ))}
    </View>
  );
}
