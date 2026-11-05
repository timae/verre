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
import { acceptAuthResponse, gateAuthRequest } from './bootGate';
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
    customFetchImpl: async (input, init) => {
      // 🔒 Reinstall-wipe gate (lib/bootGate.ts): a request built before the
      // fresh-install verdict is held (dropped if a wipe happened — the cache
      // seed above fires the first get-session at module init), a stale cookie
      // is stripped, and a response from an earlier auth generation is
      // discarded so it cannot overwrite a newer sign-in.
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const gated = await gateAuthRequest(url, init);
      init = gated.init;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const upstream = init?.signal;
      if (upstream) {
        if (upstream.aborted) controller.abort();
        else upstream.addEventListener('abort', () => controller.abort(), { once: true });
      }
      try {
        const res = await fetch(input, { ...init, signal: controller.signal });
        // 🔒 Buffer the body BEFORE the generation check. Expo's fetch resolves
        // when the headers arrive (ExpoFetchModule `responseReceived`), and
        // better-fetch only runs its state-writing hooks after awaiting the
        // body — so a response accepted here could still go stale during that
        // wait. Buffering under the same deadline closes the window; the
        // hooks then read a response whose body is already in memory.
        const body = await res.text();
        if (!acceptAuthResponse(gated.gen, res)) throw Object.assign(new Error('stale auth generation'), { name: 'AbortError' });
        const headers = new Headers();
        res.headers.forEach((v, k) => headers.append(k, v));
        const nullBody = res.status === 101 || res.status === 204 || res.status === 205 || res.status === 304;
        return new Response(nullBody ? null : body, { status: res.status, statusText: res.statusText, headers });
      } finally {
        clearTimeout(timer);
      }
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
