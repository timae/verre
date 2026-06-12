import * as SecureStore from 'expo-secure-store';

// Session-cookie storage for @better-auth/expo. THIS_DEVICE_ONLY: no iCloud
// Keychain sync — each device holds its own session (proposal 06 §2). Never
// add requireAuthentication here: the SDK reads on every request, which would
// trigger Face ID on every API call.
export const secureStorage = {
  getItem: (key: string): string | null => SecureStore.getItem(key),
  setItem: (key: string, value: string): void => {
    SecureStore.setItem(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};
