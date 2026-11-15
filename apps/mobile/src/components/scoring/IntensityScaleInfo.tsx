import { useState } from 'react';
import { View } from 'react-native';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { VText } from '@/components/ui/VText';
import { INTENSITY } from '@/lib/scoreWords';
import { useTheme } from '@/theme';

// The ⓘ at the end of a structure help line and the scale it opens: the
// numbered 0–5 intensity levels, one per row. Rating's Structure Profile and
// Filter for Structure (whose tracks write their range as these numbers). The
// menu is a Modal, so it takes no room beside the button.
export function IntensityScaleInfo() {
  const { theme } = useTheme();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <AnchorButton icon="info" iconColor={theme.inkSoft} accessibilityLabel="Intensity scale" onOpen={setAnchor} />
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={16} minWidth={180}>
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
    </>
  );
}
