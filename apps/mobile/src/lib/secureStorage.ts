import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Session storage for @better-auth/expo (authClient.ts). THIS_DEVICE_ONLY: no
// iCloud Keychain sync, each device holds its own session (proposal 06 §2).
// Never add requireAuthentication: the SDK reads on every request, which would
// trigger Face ID on every API call.
//
// 🔒 INSTALL-SCOPED KEYS (the reinstall guard, proposal 06 §2). iOS keeps
// Keychain items when the app is deleted, and native sessions last a year, so
// a reinstall (a phone handed on) would otherwise open signed in as the
// previous person. Every key the SDK uses is prefixed with an id kept in
// AsyncStorage, i.e. in the app container, which deleting the app removes. A
// reinstall gets a new id and never reads the previous install's items: online
// or offline, whatever the Keychain does with a delete, whatever chunk keys the
// SDK wrote. An update or an Offload keeps the container, so the id and the
// session survive. lib/previousInstall.ts revokes the previous install's
// session in the background. (Apple DTS recommends exactly this, tying the
// item to a random key stored on disk: developer.apple.com/forums/thread/36442.)
//
// The SDK (1.7.18) calls only the async pair. The sync pair exists for its
// type and throws, so a future SDK that reads synchronously fails loudly
// instead of reading unscoped keys: re-check on every Better Auth bump.
const WRITE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const INSTALL_ID_KEY = 'verre.installId';
// AsyncStorage: a previous install whose session is still to be revoked
// ('' = the keys from before install scoping, which had no prefix).
export const RETIRING_KEY = 'verre.retiringInstall';
// Keychain, UNscoped, so it survives a reinstall: the install that wrote it.
const INSTALL_POINTER = 'verre_install';
const LEGACY_COOKIE = 'verre_cookie';

const newId = (): string => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

async function previousInstall(): Promise<string | null> {
  try {
    const pointer = await SecureStore.getItemAsync(INSTALL_POINTER);
    if (pointer) return pointer;
    return (await SecureStore.getItemAsync(LEGACY_COOKIE)) ? '' : null;
  } catch { return null; } // unreadable: nothing to revoke, the old items stay unreachable anyway
}

// The DURABLE install id, or null while it can't be read (or, on a fresh
// install, written). Auth state is only ever stored under the durable id: a
// throwaway namespace would let a sign-in and sign-out in a broken launch
// leave the real namespace's session behind, restored on the next healthy
// launch (Codex, 2026-11-07). So while it's null, reads find nothing and
// writes are refused (signed out, sign-in can't stick), and every storage call
// retries, so a recovery mid-launch moves straight onto the real namespace.
async function resolveInstallId(): Promise<string | null> {
  let stored: string | null;
  try { stored = await AsyncStorage.getItem(INSTALL_ID_KEY); } catch { return null; }
  if (stored) return stored;
  const id = newId();
  try {
    // Recorded before the new id, so a crash between the writes can't forget it.
    const previous = await previousInstall();
    if (previous !== null) await AsyncStorage.setItem(RETIRING_KEY, previous);
    await AsyncStorage.setItem(INSTALL_ID_KEY, id);
  } catch { return null; }
  try { await SecureStore.setItemAsync(INSTALL_POINTER, id, WRITE_OPTIONS); } catch { /* the next reinstall can't revoke this one */ }
  return id;
}

let resolved: string | null = null;
let attempt: Promise<string | null> | null = null;
export function installId(): Promise<string | null> {
  if (resolved) return Promise.resolve(resolved);
  attempt ??= resolveInstallId().then((id) => { resolved = id; attempt = null; return id; });
  return attempt;
}
void installId(); // start at import: the first storage call usually finds it resolved

const syncUnsupported = (): never => { throw new Error('secureStorage: synchronous access is not install-scoped'); };
const scopedStore = (prefix: () => Promise<string | null>) => ({
  getItemAsync: async (key: string): Promise<string | null> => {
    const p = await prefix();
    return p === null ? null : SecureStore.getItemAsync(`${p}${key}`);
  },
  setItemAsync: async (key: string, value: string): Promise<void> => {
    const p = await prefix();
    if (p === null) throw new Error('secureStorage: no durable install id, nothing is stored');
    return SecureStore.setItemAsync(`${p}${key}`, value, WRITE_OPTIONS);
  },
  getItem: syncUnsupported,
  setItem: syncUnsupported,
});

export const secureStorage = scopedStore(async () => { const id = await installId(); return id && `${id}.`; });
// The previous install's items, for lib/previousInstall.ts only.
export const previousInstallStorage = (prefix: string) => scopedStore(async () => prefix);
