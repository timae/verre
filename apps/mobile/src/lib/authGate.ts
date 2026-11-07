// 🔒 Auth gate for Better Auth traffic (authClient.ts: customFetchImpl and the
// two fetch plugins around the Expo client). It keeps a sign-out from being
// undone by a request that was in flight, or created, while the sign-out ran.
// The Expo client applies a response to the session atom and the Keychain
// only after several awaited steps, and its sign-out clears local state only
// after its own awaited cookie read, so without this a straddling request can
// put the user back, and offline nothing clears them again. (Reinstall is a
// different problem, solved by construction: lib/secureStorage.ts.)
//   • auth generation — a response built under an earlier auth state is
//     discarded: a sign-out bumps when it STARTS (authClient.ts's plugin ahead
//     of the Expo client's, whose sign-out init clears the atom before the
//     request leaves), a response that sets a session cookie (sign-in, refresh)
//     bumps on arrival. Without this a slow anonymous heartbeat landing after a
//     fresh sign-in signs the new session out again. A request takes its
//     generation BEFORE the Expo client's init awaits the cookie read (a
//     sign-out during that read would otherwise send the old cookie under the
//     new generation) and is dropped unsent if the generation has moved by
//     the time it would leave. Its response is checked on arrival
//     (customFetchImpl), and a get-session again after the Expo client's
//     awaited Keychain writes, just before the SDK applies it to the atom. At
//     each of those three points a sign-out in progress would otherwise be
//     undone.
//   • signed-out latch — the generation only catches requests built BEFORE a
//     sign-out. One built after it starts (a focus heartbeat, a refetch) can
//     still read the old cookie, because the Expo client clears it only after
//     its own awaited read, and a Keychain can refuse the clear outright. So
//     from a sign-out's start until a response sets a new session cookie, no
//     request except a sign-out carries the session cookie: the server can
//     only answer it as signed out, whatever the timing (`cookieWithheld`,
//     also honoured by apiFetch).
let generation = 0;
let signedOut = false;

export function signOutStarted(): void { generation++; signedOut = true; }
export function authGeneration(): number { return generation; }

// Whether a request (other than a sign-out) must leave without the cookie.
// Check it AFTER the cookie read, right before sending: the read is async.
export function cookieWithheld(): boolean { return signedOut; }

// better-fetch awaits customFetchImpl with no try/catch, so a throw rejects the
// whole call and Better Auth's query keeps its current data. Named like a fetch
// abort so nothing mistakes it for a server error.
function abortError(reason: string): Error {
  return Object.assign(new Error(reason), { name: 'AbortError' });
}

// `builtAt`: the generation the request was stamped with before the Expo
// client's init read its cookie (authClient.ts); a request whose auth state
// moved on since then is never sent.
export function gateAuthRequest(url: string, init?: RequestInit, builtAt = generation): { init?: RequestInit; gen: number } {
  if (builtAt !== generation) throw abortError('stale auth generation: the auth state changed while the request was built');
  // A sign-out keeps the cookie it read (it revokes that session server-side).
  if (signedOut && !url.includes('/sign-out')) {
    const headers = new Headers(init?.headers);
    headers.delete('cookie');
    init = { ...init, headers };
  }
  return { init, gen: builtAt };
}

export function acceptAuthResponse(gen: number, res: Response): boolean {
  if (gen !== generation) return false;
  const setCookie = res.headers.get('set-cookie') ?? '';
  if (/session_token|session_data/.test(setCookie)) generation++;
  // A new session (sign-in) ends the latch; a sign-out's `session_token=; Max-Age=0` does not.
  if (/session_token=[^;\s"]/.test(setCookie)) signedOut = false;
  return true;
}
