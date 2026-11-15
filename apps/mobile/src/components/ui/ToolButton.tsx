import { useRef } from 'react';
import { Pressable, View, type ViewInstance } from 'react-native';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

// The toolbar button beside a list's search field: the Moments tab's outlined
// pill (ruled 2026-11-14 for every list, over the design's round `.yo-tbtn`:
// the filter shows HOW MANY filters are on). 36pt tall, rule outline, surface
// fill, glyph 16; `active` = accent glyph, `count` (> 0) = the accent number
// after it. `onPress` gets the button's window frame (a menu anchored under
// it). Recent / Upcoming, the profile lists and People's code button use it;
// CompareToolbar's chip-metric copies migrate when next touched.
export type ToolAnchor = { x: number; top: number; bottom: number };

export function ToolButton({ icon, label, active, count, onPress }: { icon: IconName; label: string; active?: boolean; count?: number; onPress: (at: ToolAnchor) => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const ref = useRef<ViewInstance>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => ref.current?.measureInWindow((x, y, _w, h) => onPress({ x, top: y, bottom: y + h }))}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 11,
          borderRadius: 999, borderWidth: 1, borderColor: theme.rule, backgroundColor: theme.surface,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={icon} size={16} color={active ? theme.accent : theme.inkSoft} />
        {count ? (
          <VText surface="badge" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>
            {count}
          </VText>
        ) : null}
      </Pressable>
    </View>
  );
}
