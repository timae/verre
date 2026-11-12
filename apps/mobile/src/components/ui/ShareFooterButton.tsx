import { Pressable } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// .ish-sharebtn — the accent share pill at the foot of a share sheet (the
// moment invite sheet: "Share"; Add Friends: "Share Profile Link").
export function ShareFooterButton({ title = 'Share', onPress }: { title?: string; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.accent, borderRadius: radius.pill, paddingVertical: 13, opacity: pressed ? 0.85 : 1 })}
    >
      <Icon name="share" size={18} color={theme.accentInk} />
      <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accentInk }}>{title}</VText>
    </Pressable>
  );
}
