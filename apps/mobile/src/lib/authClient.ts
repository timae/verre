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
import type { BetterAuthClientPlugin } from 'better-auth/client';
import { createAuthClient } from 'better-auth/react';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './clientVersion';
import { acceptAuthResponse, authGeneration, gateAuthRequest, signOutStarted } from './authGate';
import { API_BASE, APP_SCHEME } from './config';
import { secureStorage } from './secureStorage';
import { routeToUpdateRequired } from './updateGate';

const versionHeaders: Record<string, string> = {};
if (CLIENT_VERSION) versionHeaders[CLIENT_VERSION_HEADER] = CLIENT_VERSION;

// 🔒 Two fetch plugins bracket the Expo client's (better-fetch runs init and
// success hooks in plugin order; lib/authGate.ts, "auth generation").
// AHEAD of it, every request is stamped with the auth generation before the
// Expo client's init awaits the cookie read, and a sign-out moves the
// generation first (that init clears the atom before the request leaves).
// The stamp rides on the options object, which better-fetch spreads into the
// request context customFetchImpl receives. BEHIND it, a get-session's
// response is checked once more after the Expo client's awaited Keychain
// writes, the last step before the SDK applies it to the atom. A throw there
// takes the same path as customFetchImpl's: the query keeps its current data.
const path = (url: string, base?: string): string => new URL(url, base).pathname;
const staleGeneration = (): Error => Object.assign(new Error('stale auth generation'), { name: 'AbortError' });
const acceptedAt = new WeakMap<object, number>(); // better-fetch request context → generation it was accepted under
type Stamped = { verreAuthGen?: number };
const authGenerationStamp = {
  id: 'verre-auth-generation-stamp',
  fetchPlugins: [{
    id: 'verre-auth-generation-stamp',
    name: 'verre-auth-generation-stamp',
    init: async (url, options) => {
      if (path(url, options?.baseURL).endsWith('/sign-out')) signOutStarted();
      return { url, options: { ...options, verreAuthGen: authGeneration() } };
    },
  }],
} satisfies BetterAuthClientPlugin;
const lateGenerationCheck = {
  id: 'verre-late-generation-check',
  fetchPlugins: [{
    id: 'verre-late-generation-check',
    name: 'verre-late-generation-check',
    hooks: {
      onSuccess: async ({ request }) => {
        if (path(String(request.url)).endsWith('/get-session') && acceptedAt.get(request) !== authGeneration()) throw staleGeneration();
      },
    },
  }],
} satisfies BetterAuthClientPlugin;

// baseURL must include the full non-default basePath (Better Auth Expo docs).
export const authClient = createAuthClient({
  baseURL: `${API_BASE}/api/auth/native`,
  plugins: [
    authGenerationStamp,
    // Storage is install-scoped (lib/secureStorage.ts): a reinstall never
    // reads, restores or sends the previous install's session.
    expoClient({
      scheme: APP_SCHEME,
      storagePrefix: 'verre',
      storage: secureStorage,
    }),
    lateGenerationCheck,
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
      // 🔒 Auth gate (lib/authGate.ts): a request whose generation stamp went
      // stale is dropped unsent, the cookie is withheld while signed out, and a
      // response from an earlier auth generation is discarded so it cannot
      // undo a sign-out or overwrite a newer sign-in.
      const request = init; // better-fetch's context, handed to the success hooks as `request`
      const builtAt = (init as Stamped | undefined)?.verreAuthGen;
      if (builtAt === undefined) throw staleGeneration(); // unstamped: the plugin order above is broken
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const gated = gateAuthRequest(url, init, builtAt);
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
        if (!acceptAuthResponse(gated.gen, res)) throw staleGeneration();
        if (request) acceptedAt.set(request, authGeneration());
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
