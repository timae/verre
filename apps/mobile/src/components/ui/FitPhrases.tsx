import { useEffect, useState } from 'react';
import { VText } from '@/components/ui/VText';
import { phraseLine } from '@/lib/momentVisibilityCopy';

// A hidden measurer for a line of whole PHRASES (Create Moment's Privacy row,
// D4: "keep whole phrases that fit and end with an ellipsis"): it lays out
// the line at the caller's width and drops the last phrase until it fits on
// ONE line (or one is left), then reports how many to keep. Render it inside
// a box as wide as the visible line (it is absolute, invisible, inert).
export function FitPhrases({ phrases, onFit, right = 0 }: { phrases: string[]; onFit: (keep: number) => void; right?: number }) {
  const sig = phrases.join('\u0000');
  const [keep, setKeep] = useState(phrases.length);
  useEffect(() => setKeep(phrases.length), [sig, phrases.length]);
  return (
    <VText
      variant="small"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right, top: 0, opacity: 0 }}
      onTextLayout={(e) => {
        if (e.nativeEvent.lines.length > 1 && keep > 1) setKeep(keep - 1);
        else onFit(keep);
      }}
    >
      {phraseLine(phrases, keep)}
    </VText>
  );
}
