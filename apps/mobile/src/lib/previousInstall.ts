import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCookie, storageAdapter } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './clientVersion';
import { API_BASE, APP_SCHEME } from './config';
import { installId, previousInstallStorage, RETIRING_KEY } from './secureStorage';

// The previous install's session (lib/secureStorage.ts, "install-scoped
// keys"): unreachable to this install by construction, but still live on the
// server for up to a year. Revoked here in the background with a plain fetch
// that never touches Better Auth's client state, so a late answer can't clear
// a session signed in meanwhile. Until the server answers, the previous install
// stays recorded and the next launch retries. Then its items are cleared
// (cosmetic: nothing reads them).
const BA_KEYS = ['verre_cookie', 'verre_session_data'] as const;
const DEADLINE_MS = 12_000;

// Answered: revoked, or refused for good (a dead session). 426 and 429 are
// "not now", 5xx and network errors "try later".
const answered = (status: number): boolean => status < 500 && status !== 426 && status !== 429;

async function revoke(cookie: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie,
    'expo-origin': Linking.createURL('', { scheme: APP_SCHEME }),
  };
  if (CLIENT_VERSION) headers[CLIENT_VERSION_HEADER] = CLIENT_VERSION;
  try {
    const res = await fetch(`${API_BASE}/api/auth/native/sign-out`, {
      method: 'POST', headers, body: '{}', credentials: 'omit', signal: controller.signal,
    });
    return answered(res.status);
  } catch { return false; } finally { clearTimeout(timer); }
}

let running: Promise<void> | null = null;

export function retirePreviousInstall(): Promise<void> {
  running ??= (async () => {
    try {
      if ((await installId()) === null) return; // storage broken this launch: retried next launch
      const previous = await AsyncStorage.getItem(RETIRING_KEY);
      if (previous === null) return;
      const prefix = previous ? `${previous}.` : '';
      // The SDK's own adapter, so a chunked value reads (and clears) like the SDK wrote it.
      const old = storageAdapter(previousInstallStorage(prefix));
      const cookie = getCookie(await old.getItemAsync('verre_cookie'));
      if (cookie && !(await revoke(cookie))) return;
      for (const key of BA_KEYS) {
        try { await old.setItemAsync(key, '{}'); await SecureStore.deleteItemAsync(`${prefix}${key}`); } catch { /* unreachable anyway */ }
      }
      await AsyncStorage.removeItem(RETIRING_KEY);
    } catch { /* best-effort: retried next launch */ }
  })();
  return running;
}
