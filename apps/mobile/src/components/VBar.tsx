import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneMetrics } from '@/lib/layout';
import { useTheme } from '@/theme';

// .vbar — the design's variant-B in-flow header: borderless back chevron +
// left-aligned 18/600 title (h 36, icon optically outdented -6). Replaces the
// native stack header on in-flow screens, where iOS's centered title and
// glass back-circle fight the spec. Right-side slot for the future ⋯ menu.
export function VBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const { theme } = useTheme();
  const router = useRouter();
  const phone = usePhoneMetrics();
  const barHeight = phone.lerp(36, 38);
  const controlSize = phone.lerp(30, 34);
  const iconSize = phone.lerp(22, 23);
  const titleSize = phone.lerp(18, 19);
  const titleLine = phone.lerp(23, 24);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: barHeight, marginBottom: 2, marginLeft: -6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        hitSlop={8}
        style={({ pressed }) => ({ width: controlSize, height: controlSize, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="back" size={iconSize} color={theme.ink} />
      </Pressable>
      <VText
        numberOfLines={1}
        style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: titleSize, lineHeight: titleLine, letterSpacing: 0 }}
      >
        {title}
      </VText>
      {right}
    </View>
  );
}
