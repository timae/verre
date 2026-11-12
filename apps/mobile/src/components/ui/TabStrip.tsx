// .vtabs — the screen-level underline tab strip: the moment screen's Line-up |
// Compare (SessionTabs, a thin wrapper) and People's Friends / Followers /
// Following. CONTROLLED: the screen owns the active tab. Centred in the strip
// (Simon's try-it ruling 2026-07-02 for the moment screen; one strip, one look).
//
// `fit`: the labels shrink to fit instead of pushing the strip past the screen
// (three counted tabs at large Dynamic Type); without it each tab is sized by
// its label, as the moment screen always was.

import { Pressable, View } from 'react-native';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

export type TabStripItem<K extends string> = { key: K; label: string; accessibilityLabel?: string };

export function TabStrip<K extends string>({
  tabs, active, onSelect, fit,
}: {
  tabs: readonly TabStripItem<K>[];
  active: K;
  onSelect: (tab: K) => void;
  fit?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 2, borderBottomWidth: 1, borderBottomColor: theme.rule, marginBottom: 4 }}>
      {tabs.map(({ key, label, accessibilityLabel }) => {
        const on = key === active;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ selected: on }}
            onPress={() => { if (!on) onSelect(key); }}
            style={({ pressed }) => ({
              // 13 (was 10) — Simon's call for a roomier strip, same round as centering.
              paddingVertical: 13,
              paddingHorizontal: 12,
              borderBottomWidth: 2,
              borderBottomColor: on ? theme.accent : 'transparent',
              marginBottom: -1,
              opacity: pressed && !on ? 0.6 : 1,
              ...(fit ? { flexShrink: 1, minWidth: 0 } : null),
            })}
          >
            <VText
              style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}
              color={on ? 'ink' : 'inkSoft'}
              {...(fit ? { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.7 } : null)}
            >
              {label}
            </VText>
          </Pressable>
        );
      })}
    </View>
  );
}
