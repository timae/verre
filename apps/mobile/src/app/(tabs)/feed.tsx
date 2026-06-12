import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

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
