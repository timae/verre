import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SetGroup, SetNav } from '@/components/moments/settingsParts';
import { VBar } from '@/components/VBar';
import { authClient } from '@/lib/authClient';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';

// Interim Settings (handoff 04·4 anatomy, step 1): only what the old You
// screen carried. The real two-level Settings (account, privacy, blocked
// people, …) is a later step.
export default function Settings() {
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
  const confirmSignOut = () => {
    const who = session?.user.email || session?.user.name || '';
    Alert.alert('Sign out?', `${who ? `You're signed in as ${who}. ` : ''}You can sign back in anytime.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Settings" />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}>
        <SetGroup>
          <SetNav icon="link" label="Help & About" onPress={() => router.push('/about')} />
        </SetGroup>
        {/* Testing phase (Simon, 2026-07-16): visible in release builds too —
            re-gate on __DEV__ before a public launch. */}
        <SetGroup>
          <SetNav icon="grid" label="Dev Gallery" onPress={() => router.push('/you/dev-gallery')} />
        </SetGroup>
        <SetGroup>
          <SetNav icon="logout" label="Sign Out" action disabled={busy} onPress={confirmSignOut} />
        </SetGroup>
      </ScrollView>
    </View>
  );
}
