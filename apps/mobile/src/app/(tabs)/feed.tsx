import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// The tab SCENE background (which the glass bar frosts) is set on this tab's
// <NativeTabs.Trigger> contentStyle in (tabs)/_layout.tsx — not here — so it
// paints full-bleed under the bar like the Moments/You Stack tabs.
export default function Feed() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.md, paddingHorizontal: space.lg }}>
      <VText variant="title">Feed</VText>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <VText variant="body" color="inkSoft">The feed arrives in a later milestone.</VText>
      </View>
    </View>
  );
}
