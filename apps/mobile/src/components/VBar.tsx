import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';

// .vbar — the design's variant-B in-flow header: borderless back chevron +
// left-aligned 18/600 title (h 36, icon optically outdented -6). Replaces the
// native stack header on in-flow screens, where iOS's centered title and
// glass back-circle fight the spec. Right-side slot for the future ⋯ menu.
export function VBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const { theme } = useTheme();
  const router = useRouter();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, marginBottom: 2, marginLeft: -6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        hitSlop={8}
        style={({ pressed }) => ({ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="back" size={22} color={theme.ink} />
      </Pressable>
      <VText
        numberOfLines={1}
        style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.36 }}
      >
        {title}
      </VText>
      {right}
    </View>
  );
}
