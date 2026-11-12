import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';

// Fetchers for You → Settings (the You profile, step 3). Wire shapes MIRROR
// app/api/me/visibility, app/api/me/blocks, app/api/me/mutes,
// app/api/me/devices (+ [id]) and app/api/me/account — keep in sync by hand.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Plain queries (invalidation is fine; refetched on focus). The Privacy page
// and its Blocked / Muted pages share them; a block / mute on a profile
// invalidates the list.
export const VISIBILITY_KEY = ['me', 'visibility'] as const;
export const BLOCKS_KEY = ['me', 'blocks'] as const;
export const MUTES_KEY = ['me', 'mutes'] as const;
export const DEVICES_KEY = ['me', 'devices'] as const;

// Profile Visible To: the server's four tiers (lib/profileVisibility.ts).
// Friends = mutual follows. `fofEnabled` only applies to the two strict tiers.
export type ProfileVisibility = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual';
// Check-Ins Visible To (step 4): null = Same as Profile, else a stricter
// audience for your posts; the stricter of the two always wins, and an
// explicit choice never includes the extended circle. Only Me = a private diary.
export type CheckinVisibility = 'public-users' | 'public-followers' | 'public-mutual' | 'only-me';
export type VisibilitySettings = {
  visibility: ProfileVisibility;
  fofEnabled: boolean;
  checkinVisibility: CheckinVisibility | null;
  showCravings: boolean;
  showMoments: boolean;
  showLocations: boolean;
};
export type VisibilityChanges = Partial<VisibilitySettings>;

export async function getVisibility(): Promise<VisibilitySettings> {
  const res = await apiFetch('/api/me/visibility');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// 🔒 A COMPARE-AND-SET: `expected` = the six as last read, `changes` = only
// what this save changes. 200 → `{ ok: true, current }` (also when the change
// was already there: a retry whose first attempt committed); 409 → `{ ok:
// false, current }`, the server's settings moved since `expected` and nothing
// was written. Anything else throws (ApiError carries no body, so the 409's
// `current` is read here). `current` is null only from a server that predates
// the shape: re-read.
export async function patchVisibility(
  expected: VisibilitySettings,
  changes: VisibilityChanges,
): Promise<{ ok: boolean; current: VisibilitySettings | null }> {
  const res = await apiFetch('/api/me/visibility', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ expected, ...changes }) });
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body?.current) return { ok: false, current: body.current as VisibilitySettings };
    await throwApiError(res);
  }
  if (!res.ok) await throwApiError(res);
  const body = await res.json().catch(() => null);
  return { ok: true, current: (body?.current as VisibilitySettings | undefined) ?? null };
}

// Your own lists, newest first. A muted user who blocked you is left out
// server-side; the rows render initials only.
export type ListedPerson = { id: number; name: string };
export async function getBlocks(): Promise<ListedPerson[]> {
  const res = await apiFetch('/api/me/blocks');
  if (!res.ok) await throwApiError(res);
  return ((await res.json()).blocks as ListedPerson[]).map(({ id, name }) => ({ id, name }));
}
export async function getMutes(): Promise<ListedPerson[]> {
  const res = await apiFetch('/api/me/mutes');
  if (!res.ok) await throwApiError(res);
  return ((await res.json()).mutes as ListedPerson[]).map(({ id, name }) => ({ id, name }));
}

// Signed-in devices: web rows (uuid ids) and native rows (`ba:<id>`).
// `deviceLabel` is a ready-made label ("iPhone 15 Pro · Verre App",
// "MacBook · Safari", "Unknown device"); `geoLabel` a country name or null.
export type Device = { id: string; deviceLabel: string | null; geoLabel: string | null; createdAt: string; lastSeenAt: string; isCurrent: boolean };
export async function getDevices(): Promise<Device[]> {
  const res = await apiFetch('/api/me/devices');
  if (!res.ok) await throwApiError(res);
  return (await res.json()).devices;
}

// The password-gated actions (Settings → Account) send a JSON body on DELETE.
// 🔒 The password is only ever in this request body: never logged, never kept.
export async function signOutDevice(id: string, password: string): Promise<void> {
  const res = await apiFetch(`/api/me/devices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ password }) });
  if (!res.ok) await throwApiError(res);
}
// Change Email: the same PATCH the web uses; from the app it must carry the
// current password (the server checks it for a native caller).
export async function changeEmail(email: string, password: string): Promise<void> {
  const res = await apiFetch('/api/me/account', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ email, currentPassword: password }) });
  if (!res.ok) await throwApiError(res);
}
export async function signOutOtherDevices(password: string): Promise<void> {
  const res = await apiFetch('/api/me/devices', { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ password }) });
  if (!res.ok) await throwApiError(res);
}

// Delete Account (step-3 plan T4). The outcome classes the screen acts on:
//  - 'deleted'      200: gone; the app signs out.
//  - 'refused'      400 (wrong / missing password) or 429: nothing happened,
//                   the phone is still signed in. `message` = what to say.
//  - 'failed'       409 / 503 / 500 WITH the route's JSON error: the account
//                   is intact, but the server revoked this phone's session
//                   before the step that failed (lib/accountDelete.ts).
//                   `tooManyMoments` = the 409. Also a 401 with our body: this
//                   phone's session was already gone, nothing was deleted.
//  - 'unknown'      a timeout, a network error, or any status without our JSON
//                   body (a proxy 502 / 504): the server may still be deleting.
export type DeleteAccountOutcome =
  | { kind: 'deleted' }
  | { kind: 'refused'; status: number; message: string | null }
  | { kind: 'failed'; tooManyMoments: boolean }
  | { kind: 'unknown' };

// ONE overall deadline over the request AND the body: apiFetch's own timeout
// clears when the headers arrive, so a stalled body would otherwise hang.
const DELETE_DEADLINE_MS = 120_000;

export async function deleteAccount(password: string): Promise<DeleteAccountOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), DELETE_DEADLINE_MS); });
  const attempt = (async () => {
    const res = await apiFetch('/api/me/account', {
      method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ password }), timeoutMs: DELETE_DEADLINE_MS,
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  })();
  try {
    const r = await Promise.race([attempt, deadline]);
    if (r === 'timeout') return { kind: 'unknown' };
    const ours = typeof r.body === 'object' && r.body !== null;
    const error = ours && typeof (r.body as { error?: unknown }).error === 'string' ? (r.body as { error: string }).error : null;
    if (r.status === 200 && ours && (r.body as { ok?: unknown }).ok === true) return { kind: 'deleted' };
    if ((r.status === 400 || r.status === 429) && ours) return { kind: 'refused', status: r.status, message: error };
    if ((r.status === 401 || r.status === 409 || r.status === 503 || r.status === 500) && error != null) return { kind: 'failed', tooManyMoments: r.status === 409 };
    return { kind: 'unknown' };
  } catch (e) {
    // A 426 is answered before any route runs (nothing was deleted) and
    // apiFetch has already routed to the update screen: let it through.
    // Anything else is a transport failure or an abort: outcome unknown.
    if (e instanceof Error && e.message === 'update_required') throw e;
    return { kind: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}
