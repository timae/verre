import Constants from 'expo-constants';
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
