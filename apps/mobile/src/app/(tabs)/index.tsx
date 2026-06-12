import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// 02s Moments home — quiet state only for the skeleton. The live strip, join
// block, and recents land with the sessions milestone.
export default function Moments() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.md, paddingHorizontal: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <VText variant="title">Moments</VText>
        <Button title="+ New" size="sm" disabled />
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs }}>
        <VText variant="subhead">Nothing live right now</VText>
        <VText variant="body" color="inkSoft">Moments arrive in the next milestone.</VText>
      </View>
    </View>
  );
}
