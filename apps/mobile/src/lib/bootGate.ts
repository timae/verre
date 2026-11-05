import { secureStorage } from './secureStorage';

// 🔒 Boot gate for Better Auth traffic — the request-side half of the reinstall
// wipe (lib/freshInstall.ts owns the decision; read its header first).
//
// Why requests need gating at all: the Expo client's cache seed calls
// `sessionAtom.get()` at module init, and a nanostores `get()` on a store with
// no listeners temporarily subscribes — which mounts Better Auth's session
// query and fires the first /get-session heartbeat BEFORE any React code runs,
// let alone the guard. That request carries whatever cookie the Keychain held,
// and its response re-writes `verre_cookie` + `verre_session_data` and the
// session atom: a delayed answer would restore a previous owner AFTER the wipe.
// So every Better Auth request passes through here (authClient.ts
// customFetchImpl):
//   • built before the verdict → held; dropped (never sent) if a wipe happened,
//     sent as-is otherwise. The guard's own sign-out is the one request allowed
//     through while the wipe runs.
//   • `cookieIsStale` — if the Keychain refused to give the stale cookie up
//     (or could not even be read), it is stripped from every request until
//     storage changes; an UNREADABLE cookie strips for the rest of the launch.
//   • auth generation — a response built under an earlier auth state is
//     discarded: sign-out bumps on request, a response that sets a session
//     cookie (sign-in, refresh) bumps on arrival. Without this a slow anonymous
//     heartbeat landing after a fresh sign-in signs the new session out again.
type Verdict = 'kept' | 'wiped';
export const UNREADABLE_COOKIE = Symbol('unreadable-cookie');
export type StaleCookie = string | typeof UNREADABLE_COOKIE | null;
let verdict: Verdict | null = null;
let wiping = false;
let staleCookie: StaleCookie = null;
let waiters: Array<(v: Verdict) => void> = [];
let generation = 0;

export const bootGate = {
  beginWipe(): void { wiping = true; },
  settle(v: Verdict, stale: StaleCookie = null): void {
    if (verdict) return;
    verdict = v; staleCookie = stale;
    const release = waiters; waiters = [];
    release.forEach((r) => r(v));
  },
  get settled(): boolean { return verdict !== null; },
};

export function cookieIsStale(): boolean {
  if (staleCookie === null) return false;
  if (staleCookie === UNREADABLE_COOKIE) return true;
  try { return secureStorage.getItem('verre_cookie') === staleCookie; } catch { return true; }
}

// better-fetch awaits customFetchImpl with no try/catch, so a throw rejects the
// whole call and Better Auth's query keeps its current data (null after the
// wipe's reset). Named like a fetch abort so nothing mistakes it for a server
// error.
function abortError(reason: string): Error {
  return Object.assign(new Error(reason), { name: 'AbortError' });
}

export async function gateAuthRequest(url: string, init?: RequestInit): Promise<{ init?: RequestInit; gen: number }> {
  if (verdict === null && !(wiping && url.includes('/sign-out'))) {
    if ((await new Promise<Verdict>((r) => waiters.push(r))) === 'wiped') throw abortError('dropped: built before the reinstall-wipe verdict');
  }
  if (url.includes('/sign-out')) generation++;
  if (cookieIsStale()) {
    const headers = new Headers(init?.headers);
    headers.delete('cookie');
    init = { ...init, headers };
  }
  return { init, gen: generation };
}

export function acceptAuthResponse(gen: number, res: Response): boolean {
  if (gen !== generation) return false;
  if (/session_token|session_data/.test(res.headers.get('set-cookie') ?? '')) generation++;
  return true;
}
