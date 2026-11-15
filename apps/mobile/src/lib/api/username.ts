import { apiFetch } from '../apiFetch';
import { ApiError, throwApiError } from './sessions';

// Your own username (docs/dev/proposals/usernames.md § 8). Wire types MIRROR
// app/api/me/username/route.ts and its `available` route: keep in sync by hand.

// `changesLeft` of 5 per rolling 90 days (a first choice is free);
// `nextChangeAt` = when the next change is possible once none are left;
// `previous` = the one old name still reserved for you (never after a
// moderation rename).
export type UsernameState = {
  username: string | null;
  changesLeft: number;
  nextChangeAt: string | null;
  previous: { username: string; heldUntil: string } | null;
};
export const USERNAME_KEY = ['me', 'username'] as const;

export async function getUsernameState(): Promise<UsernameState> {
  const res = await apiFetch('/api/me/username');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// A refused change. `taken` covers taken AND held (one answer); `quota`
// carries the date the next change is possible.
export class UsernameError extends ApiError {
  code: 'invalid' | 'reserved' | 'taken' | 'quota' | null;
  nextChangeAt: string | null;
  constructor(status: number, message: string | undefined, code: UsernameError['code'], nextChangeAt: string | null) {
    super(status === 429 ? 'rate-limited' : 'http', status, message);
    this.code = code;
    this.nextChangeAt = nextChangeAt;
  }
}

export async function putUsername(username: string): Promise<UsernameState> {
  const res = await apiFetch('/api/me/username', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.code === 'invalid' || body?.code === 'reserved' || body?.code === 'taken' || body?.code === 'quota' ? body.code : null;
  throw new UsernameError(res.status, typeof body?.error === 'string' ? body.error : undefined, code, typeof body?.nextChangeAt === 'string' ? body.nextChangeAt : null);
}

// Advisory (the PUT's answer is the authority). 60 a minute per account.
export type UsernameAvailability = { available: boolean; reason?: 'invalid' | 'reserved' | 'taken' };
export async function checkUsernameAvailable(username: string, signal?: AbortSignal): Promise<UsernameAvailability> {
  const res = await apiFetch(`/api/me/username/available?username=${encodeURIComponent(username)}`, { signal });
  if (!res.ok) await throwApiError(res);
  return res.json();
}
