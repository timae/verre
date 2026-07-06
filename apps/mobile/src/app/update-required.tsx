import { useLocalSearchParams } from 'expo-router';
import { Linking, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// Routes are deep-linkable (io.verre.app://update-required?storeUrl=…), so the
// param is attacker-influencable — only store destinations may reach openURL.
const SAFE_STORE_URL = /^(https:\/\/apps\.apple\.com\/|itms-apps:|https:\/\/play\.google\.com\/)/;

// Blocking min-version screen (proposal 04 §3) — must exist in build #1; the
// server floor (NATIVE_MIN_VERSION_IOS) decides when it shows. Copy is
// provisional: this screen isn't in the design handoff yet.
export default function UpdateRequired() {
  const params = useLocalSearchParams<{ minVersion?: string; storeUrl?: string }>();
  const storeUrl = params.storeUrl && SAFE_STORE_URL.test(params.storeUrl) ? params.storeUrl : null;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
      <VText variant="heading">Update Required</VText>
      <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>
        This version of the app is no longer supported. Please update to keep tasting.
      </VText>
      <Button
        title="Update"
        style={{ marginTop: space.md }}
        disabled={!storeUrl}
        onPress={() => { if (storeUrl) Linking.openURL(storeUrl); }}
      />
    </View>
  );
}
