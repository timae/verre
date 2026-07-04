import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// The tab SCENE background comes from the tabs layout's shared sceneStyle
// (js-tabs, ADR-0006) — not here — so it paints full-bleed under the pill
// like the Moments/You Stack tabs.
export default function Feed() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.md, paddingHorizontal: space.lg, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}>
      <VText variant="title">Feed</VText>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <VText variant="body" color="inkSoft">The feed arrives in a later milestone.</VText>
      </View>
    </View>
  );
}
