import { authClient } from './authClient';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './clientVersion';
import { API_BASE } from './config';
import { routeToUpdateRequired } from './updateGate';

// The single place the app talks to the Verre API: session cookie + client
// version on every call, and the 426 update-required handshake (proposal 04).
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (CLIENT_VERSION) headers.set(CLIENT_VERSION_HEADER, CLIENT_VERSION);
  const cookie = authClient.getCookie();
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 426) {
    let body: { minVersion?: string; storeUrl?: string } | null = null;
    try { body = await res.json(); } catch { /* body shape is best-effort */ }
    routeToUpdateRequired(body);
    throw new Error('update_required');
  }
  return res;
}
