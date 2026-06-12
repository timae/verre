import { authClient } from './authClient';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './clientVersion';
import { API_BASE } from './config';
import { routeToUpdateRequired } from './updateGate';

// RN fetch has NO default timeout — a poll into a dead radio hangs 30–60s on
// TCP (proposal 02 §4), so every call gets an AbortController deadline.
const DEFAULT_TIMEOUT_MS = 12_000;

// The single place the app talks to the Verre API: session cookie + client
// version on every call, and the 426 update-required handshake (proposal 04).
export async function apiFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (CLIENT_VERSION) headers.set(CLIENT_VERSION_HEADER, CLIENT_VERSION);
  const cookie = authClient.getCookie();
  if (cookie) headers.set('Cookie', cookie);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstream = rest.signal;
  const forwardAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener('abort', forwardAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...rest, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', forwardAbort);
  }
  if (res.status === 426) {
    let body: { minVersion?: string; storeUrl?: string } | null = null;
    try { body = await res.json(); } catch { /* body shape is best-effort */ }
    routeToUpdateRequired(body);
    throw new Error('update_required');
  }
  return res;
}
