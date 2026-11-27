import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';

// The small line under your name on your OWN hidden post (Moment Visibility
// step 3, R3): the struck-through eye (like blind's "Hidden from guests", not a
// lock) and the words lead the byline's caption, then what it said before
// (place · time). Without a `line`, exactly the old caption. Only you ever see
// it: the field it reads rides only on your own posts.
export function PrivacyByline({ line, children, style }: { line: string | null; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { theme } = useTheme();
  if (line === null) {
    return children ? (
      <VText variant="caption" color="inkSoft" numberOfLines={1} style={style}>
        {children}
      </VText>
    ) : null;
  }
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4 }, style]}>
      <Icon name="eyeoff" size={13} color={theme.inkSoft} />
      <VText variant="caption" color="inkSoft" numberOfLines={1} style={{ flexShrink: 1 }}>
        <VText variant="caption" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {line}
        </VText>
        {children ? ' · ' : ''}
        {children}
      </VText>
    </View>
  );
}
