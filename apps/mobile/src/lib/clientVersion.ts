import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

// X-Verre-Client: <platform>/<nativeVersion>/<otaUpdateId|embedded> (proposal 04 §3a).
// No EAS Update is configured yet, so the OTA slot is the literal 'embedded'.
// When OTA lands: read the update id from expo-updates AND pin runtimeVersion
// to the fingerprint policy (06 §6) before shipping any OTA bundle.
export const CLIENT_VERSION_HEADER = 'X-Verre-Client';
// null on non-store platforms (the Expo web target): the server's parser only
// knows ios|android, and a `web/...` header would 426 once a floor is set.
export const CLIENT_VERSION =
  Platform.OS === 'ios' || Platform.OS === 'android'
    ? `${Platform.OS}/${Constants.expoConfig?.version ?? '0.0.0'}/embedded`
    : null;

// The app's own User-Agent on Better Auth requests. The server labels the
// device from it at SIGN-IN only ("iPhone 15 Pro · Verre App",
// lib/userAgent.ts parseNativeUserAgent; any other shape falls back to its
// browser parser). iPhone-only app, so no Android shape yet.
export const AUTH_USER_AGENT =
  Platform.OS === 'ios'
    ? `Verre/${Application.nativeApplicationVersion ?? '0'} (${Device.modelName ?? 'iPhone'}; iOS ${Device.osVersion ?? '0'})`
    : null;

// Settings footer ("Verre 1.0.0 · Build 42"). The build number comes from the
// binary: eas.json's remote version source + autoIncrement leave app.json's
// buildNumber stale.
export const APP_VERSION = Application.nativeApplicationVersion;
export const APP_BUILD = Application.nativeBuildVersion;
