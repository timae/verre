// .vtabs — Line-up | Compare, one strip shared by both layouts of the session
// screen. CONTROLLED (Simon's ruling 2026-07-02): Compare is an in-screen tab
// swap — everything above the tabs (bar or cover hero) stays identical and
// there is no route change, no back-to-line-up.

import { Pressable, View } from 'react-native';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

export type SessionTab = 'lineup' | 'compare';

export function SessionTabs({ active, onSelect }: { active: SessionTab; onSelect: (tab: SessionTab) => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const tab = (key: SessionTab, label: string) => {
    const on = key === active;
    return (
      <Pressable
        key={key}
        accessibilityRole="tab"
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
        })}
      >
        <VText
          style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}
          color={on ? 'ink' : 'inkSoft'}
        >
          {label}
        </VText>
      </Pressable>
    );
  };
  return (
    // Centered in the strip (Simon's try-it ruling 2026-07-02 — was left-aligned).
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 2, borderBottomWidth: 1, borderBottomColor: theme.rule, marginBottom: 4 }}>
      {tab('lineup', 'Line-up')}
      {tab('compare', 'Compare')}
    </View>
  );
}
