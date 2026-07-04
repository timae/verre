import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// The undecided 4th tab (explore vs notifications — handoff §12). A calm
// placeholder until that decision lands. Scene background comes from the tabs
// layout's shared sceneStyle (js-tabs, ADR-0006).
export default function Soon() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.md, paddingHorizontal: space.lg, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}>
      <VText variant="title">Soon</VText>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs }}>
        <VText variant="subhead">Something is brewing</VText>
        <VText variant="body" color="inkSoft">This space opens up in a later update.</VText>
      </View>
    </View>
  );
}
