import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { authClient } from '@/lib/authClient';
import { space } from '@/theme';

export default function You() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    // Must go through BA so the Redis-first session actually revokes.
    await authClient.signOut();
    setBusy(false);
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.md, paddingHorizontal: space.lg, gap: space.md }}>
      <VText variant="title">You</VText>
      <View style={{ gap: space['2xs'] }}>
        <VText variant="subhead">{session?.user.name ?? ''}</VText>
        <VText variant="body" color="inkSoft">{session?.user.email ?? ''}</VText>
      </View>
      <View style={{ flex: 1 }} />
      {/* Testing phase (Simon, 2026-07-16): visible in release builds too —
          re-gate on __DEV__ before a public launch. */}
      <Button title="Dev Gallery" variant="tertiary" onPress={() => router.push('/you/dev-gallery')} />
      <Button title="Sign Out" loadingTitle="Signing out…" variant="secondary" block loading={busy} onPress={signOut} style={{ marginBottom: insets.bottom + TAB_BAR_CLEARANCE }} />
    </View>
  );
}
