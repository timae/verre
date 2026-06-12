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
