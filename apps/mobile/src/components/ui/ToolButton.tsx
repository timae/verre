import { useRef } from 'react';
import { Pressable, View, type ViewInstance } from 'react-native';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useTheme } from '@/theme';

// .yo-tbtn on the app's toolbar standard (People D12: 36pt, not the mock's
// 46): rule border, surface fill, glyph 17 ink-soft; `active` (a filter is on)
// = `.yo-tbtn.is-active`: accent glyph, accent-line border, accent-tint fill
// and the 7pt accent dot ringed in the surface. `onPress` gets the button's
// window frame (a menu anchored under it). People's code button and the
// profile lists use it; CompareToolbar's chip-metric copies migrate when next
// touched.
export type ToolAnchor = { x: number; top: number; bottom: number };

export function ToolButton({ icon, label, active, onPress }: { icon: IconName; label: string; active?: boolean; onPress: (at: ToolAnchor) => void }) {
  const { theme } = useTheme();
  const ref = useRef<ViewInstance>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={active === undefined ? undefined : { selected: active }}
        onPress={() => ref.current?.measureInWindow((x, y, _w, h) => onPress({ x, top: y, bottom: y + h }))}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          width: 36, height: 36, borderRadius: 999, borderWidth: 1,
          borderColor: active ? theme.accentLine : theme.rule,
          backgroundColor: active ? theme.accentTint : theme.surface,
          alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={icon} size={17} color={active ? theme.accent : theme.inkSoft} />
        {active ? (
          <View style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 999, backgroundColor: theme.accent, borderWidth: 2, borderColor: theme.surface }} />
        ) : null}
      </Pressable>
    </View>
  );
}
