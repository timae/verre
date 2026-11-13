import { useLocalSearchParams } from 'expo-router';
import { Linking, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space } from '@/theme';

// Routes are deep-linkable (io.verre.app://update-required?storeUrl=…), so the
// param is attacker-influencable — only store destinations may reach openURL.
// TestFlight (`https://testflight.apple.com/`, `itms-beta:`) since 0.1.5: the
// testers' update lives there (public-user-ids § 6).
const SAFE_STORE_URL = /^(https:\/\/apps\.apple\.com\/|itms-apps:|https:\/\/play\.google\.com\/|https:\/\/testflight\.apple\.com\/|itms-beta:)/;

// Blocking min-version screen (proposal 04 §3) — must exist in build #1; the
// server floor (CODE_FLOOR_IOS / NATIVE_MIN_VERSION_IOS) decides when it
// shows. Copy is provisional: this screen isn't in the design handoff yet.
export default function UpdateRequired() {
  const params = useLocalSearchParams<{ minVersion?: string; storeUrl?: string }>();
  return <UpdateRequiredView storeUrl={params.storeUrl} />;
}

// The screen itself, also rendered DIRECTLY by the root layout when a 426
// arrives before any navigator exists (lib/updateGate.ts).
export function UpdateRequiredView({ storeUrl: rawStoreUrl }: { storeUrl?: string }) {
  const storeUrl = rawStoreUrl && SAFE_STORE_URL.test(rawStoreUrl) ? rawStoreUrl : null;
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
