import { Alert } from 'react-native';
import { authClient } from './authClient';

// The app's one sign-out: Settings → Sign Out and Account → This Device's Sign
// Out. The confirm names the signed-in account; no password (it's a logout).
// 🔒 Through Better Auth, so the Redis-first session actually revokes.
export function confirmSignOut(who: string | null | undefined, setBusy: (busy: boolean) => void): void {
  Alert.alert('Sign out?', `${who ? `You're signed in as ${who}. ` : ''}You can sign back in anytime.`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Sign Out',
      style: 'destructive',
      onPress: async () => {
        setBusy(true);
        try {
          await authClient.signOut();
        } finally {
          setBusy(false);
        }
      },
    },
  ]);
}
