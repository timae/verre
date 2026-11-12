import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { firstName } from '@/lib/initials';
import { useTheme } from '@/theme';

// .ish-chip — a person as a quick-add chip: avatar + a "+" badge + first name
// (the moment invite sheet's "Quick add", Add Friends' "People you tasted
// with"). `done`: the badge turns into a ✓ and the chip goes inert (a follow
// that just went through).
export function QuickAddChip({
  name, imageUrl, onPress, accessibilityLabel, done,
}: {
  name: string;
  imageUrl: string | null;
  onPress: () => void;
  accessibilityLabel: string;
  done?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={done ? { disabled: true } : undefined}
      disabled={done}
      onPress={onPress}
      style={{ alignItems: 'center', gap: 6, width: 60 }}
    >
      <Avatar
        imageUrl={imageUrl}
        name={name}
        size={52}
        initialsSize={16}
        badge={
          <View style={{ position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: done ? theme.positive : theme.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: theme.surface }}>
            <Icon name={done ? 'check' : 'plus'} size={11} color={done ? theme.surface : theme.accentInk} />
          </View>
        }
      />
      <VText variant="caption" numberOfLines={1}>{firstName(name)}</VText>
    </Pressable>
  );
}
