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
          paddingVertical: 10,
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
    <View style={{ flexDirection: 'row', gap: 2, borderBottomWidth: 1, borderBottomColor: theme.rule, marginBottom: 4 }}>
      {tab('lineup', 'Line-up')}
      {tab('compare', 'Compare')}
    </View>
  );
}
