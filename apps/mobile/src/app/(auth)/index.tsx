import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// 01·1 Launch — prototype .welcome: centered wordmark (heading size, accent
// dot) pinned top, h1 at title size, body line at small size above the
// buttons. The hero photo + white-over-photo treatment lands with real assets
// later; until then the text uses theme inks on the plain bg. Copy is final.
export default function Launch() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.lg }}>
      <View style={{ alignItems: 'center', gap: space.md }}>
        <VText variant="heading">
          verre<VText variant="heading" color="accent">.</VText>
        </VText>
        <VText variant="title" style={{ textAlign: 'center' }}>
          Everything you taste{'\n'}In one place
        </VText>
      </View>
      <View style={{ flex: 1 }} />
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', marginBottom: space.lg }}>
        Wine, coffee, the dish you can&apos;t stop thinking about — capture it, score it, remember why.
      </VText>
      <View style={{ gap: 10 }}>
        <Button title="Get started" bar block onPress={() => router.push('/sign-up')} />
        <Button title="Sign in" bar block variant="secondary" onPress={() => router.push('/sign-in')} />
      </View>
    </View>
  );
}
