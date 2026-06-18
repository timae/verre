import { router } from 'expo-router';
import { View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// Unknown routes/deep links (a bad io.verre.app:// link) land here instead of
// expo-router's unbranded Unmatched screen.
export default function NotFound() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
      <VText variant="heading">Nothing here</VText>
      <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>
        That link doesn&apos;t go anywhere.
      </VText>
      <Button title="Back to start" variant="secondary" style={{ marginTop: space.md }} onPress={() => router.replace('/')} />
    </View>
  );
}
