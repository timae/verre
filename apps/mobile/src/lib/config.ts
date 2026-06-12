import Constants from 'expo-constants';
import { Platform } from 'react-native';

// iOS Simulator talks to localhost; the Android emulator reaches the host via
// 10.0.2.2; a physical device needs the Mac's LAN address — set
// EXPO_PUBLIC_API_URL (or app.json extra.apiBaseUrl) for device builds.
export const API_BASE: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000');
