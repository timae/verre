import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Shared base-URL resolution for the backend. iOS Simulator talks to localhost;
// the Android emulator reaches the host via 10.0.2.2; a physical device needs
// the Mac's LAN address — set EXPO_PUBLIC_API_URL (or app.json extra.apiBaseUrl)
// for device builds. EXPO_PUBLIC_* vars are inlined into the JS bundle at build
// time (provide via apps/mobile/.env.local — see .env.example).
const apiBase: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000');

export const API_BASE: string = apiBase;

// Public web origin used to build shareable links (e.g. the /join/<code> invite
// URL). In prod this is the real domain; set EXPO_PUBLIC_WEB_URL to it. With no
// override it falls back to API_BASE so a local deployment's links resolve
// against the same backend the app already talks to (a localhost link only
// opens on the Simulator's own machine — a real second device needs the LAN-IP
// form via EXPO_PUBLIC_API_URL, same as everything else).
export const WEB_BASE: string =
  process.env.EXPO_PUBLIC_WEB_URL ??
  (Constants.expoConfig?.extra?.webBaseUrl as string | undefined) ??
  apiBase;
