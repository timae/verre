// Side-effect imports — load-bearing. @better-auth/expo's client lazily does
// `import("expo-network")` (and `import("expo-web-browser")` for social),
// which Metro's dev `lazy` mode turns into async split chunks; under the
// bytecode+lazy param set the entry bundle's chunk-path map misses the entry
// and the require dies with "Requiring unknown module N". Importing them
// statically here pulls both into the entry bundle, so Metro dedupes the
// dynamic import into a plain in-bundle require.
import 'expo-network';
import 'expo-web-browser';
import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/react';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './clientVersion';
import { API_BASE } from './config';
import { secureStorage } from './secureStorage';
import { routeToUpdateRequired } from './updateGate';

const versionHeaders: Record<string, string> = {};
if (CLIENT_VERSION) versionHeaders[CLIENT_VERSION_HEADER] = CLIENT_VERSION;

// baseURL must include the full non-default basePath (Better Auth Expo docs).
export const authClient = createAuthClient({
  baseURL: `${API_BASE}/api/auth/native`,
  plugins: [
    expoClient({
      scheme: 'io.verre.app',
      storagePrefix: 'verre',
      storage: secureStorage,
    }),
  ],
  fetchOptions: {
    headers: versionHeaders,
    // ⚠️ RN fetch has NO DEFAULT TIMEOUT. apiFetch.ts guards every Verre API
    // call with an AbortController for exactly this reason, but the Better Auth
    // client does not route through it — so without this, a request against an
    // unreachable server hangs on the OS TCP timeout (30–60s+). That is what
    // held the boot splash dark, since the root layout gates first paint on the
    // get-session heartbeat.
    //
    // Longer than apiFetch's 12s default would be pointless here: this is the
    // launch path, and the root layout paints regardless after 2.5s. This
    // deadline exists so the request itself ends rather than lingering.
    customFetchImpl: (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const upstream = init?.signal;
      if (upstream) {
        if (upstream.aborted) controller.abort();
        else upstream.addEventListener('abort', () => controller.abort(), { once: true });
      }
      return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
    },
    async onError(ctx) {
      if (ctx.response?.status !== 426) return;
      // BA traffic (the get-session heartbeat) is the main 426 producer — and
      // the FIRST get-session fires before the root layout mounts, so routing
      // goes through the updateGate buffer, never bare router.replace.
      let body: { minVersion?: string; storeUrl?: string } | null = null;
      try { body = await ctx.response.clone().json(); } catch { /* best-effort */ }
      routeToUpdateRequired(body);
    },
  },
});
