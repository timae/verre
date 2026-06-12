import { apiFetch } from '../apiFetch';

// Typed fetchers for the session surfaces. Wire types mirror the server
// builders (lib/sessionState.ts, lib/session.ts wineToWire) — keep in sync.

export type SessionRole = 'host' | 'cohost' | 'provider' | null;

export type MySessionRow = {
  id: number;
  code: string;
  host_name: string;
  name: string | null;
  created_at: string;
  joined_at: string;
  wines_rated: number;
  avg_score: number | null;
  date_from: string | null;
  date_to: string | null;
  address: string | null;
  host_user_id: number | null;
  wine_count: number;
  ttl_seconds: number;
  lifespan: string | null;
  taster_count: number | null;
  role: SessionRole;
  // Server-computed Moments-home pinning: live = Redis alive + caller still
  // a participant + any set date not clearly over.
  status: 'live' | 'past';
};

export const isLiveSession = (r: MySessionRow) => r.status === 'live';

export type WireWine = {
  id: string;
  name: string;
  producer: string;
  vintage: string;
  grape: string;
  type: string;
  image: string;
  imageUrl: string;
  description?: string;
  region?: string;
  country?: string;
  vinification?: string;
  purchaseUrl?: string;
  revealedAt?: string | null;
  isMine: boolean;
  addedByDisplayName: string | null;
  addedByUserId: number | null;
  _blind?: boolean;
};

export type SessionParticipant = { id: string; displayName: string; imageUrl: string | null };

export type SessionMetaView = {
  code: string;
  host: string;
  name: string;
  createdAt: number;
  hostUserId: number | null;
  hostIdentityId?: string;
  blind?: boolean;
  blindForEveryone?: boolean;
  lifespan?: string;
  coHostIds?: string[];
  providerIds?: string[];
  address?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  timezone?: string;
  description?: string;
  link?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  participants: SessionParticipant[];
  ttlSeconds: number;
  viewerBlocksOut: string[];
  viewerBlocksIn: string[];
  banCount: number;
};

export type RatingMeta = { score: number; flavors: Record<string, number>; notes: string; at: number };
export type RatingsView = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>;

export type SessionState = {
  meta: SessionMetaView | null;
  wines: WireWine[] | null;
  ratings: RatingsView | null;
};

export type ApiErrorKind =
  | 'not-found' // 404 — session gone, go home
  | 'removed' // X-Vr-Auth: removed — kicked/banned by the host
  | 'invalid' // X-Vr-Auth: invalid — identity didn't resolve, rejoin
  | 'banned' // join refused (403 { error: 'banned' })
  | 'rate-limited' // 429 — body carries a human wait message
  | 'http'; // anything else

export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number;
  constructor(kind: ApiErrorKind, status: number, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.status = status;
  }
}

async function bodyError(res: Response): Promise<string | undefined> {
  try {
    const j = await res.json();
    return typeof j?.error === 'string' ? j.error : undefined;
  } catch {
    return undefined;
  }
}

async function throwApiError(res: Response): Promise<never> {
  const vrAuth = res.headers.get('X-Vr-Auth');
  if (vrAuth === 'removed') throw new ApiError('removed', res.status);
  if (vrAuth === 'invalid') throw new ApiError('invalid', res.status);
  const msg = await bodyError(res);
  if (res.status === 404) throw new ApiError('not-found', 404, msg);
  if (res.status === 429) throw new ApiError('rate-limited', 429, msg);
  if (res.status === 403 && msg === 'banned') throw new ApiError('banned', 403, msg);
  throw new ApiError('http', res.status, msg);
}

export async function getMySessions(): Promise<MySessionRow[]> {
  const res = await apiFetch('/api/me/sessions');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getSessionState(code: string): Promise<SessionState> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/state`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// Registers a logged-in visitor in the session's identities map — MUST run
// (and succeed) before the first /state poll, which 401s for non-participants.
export async function postVisit(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/visit`, { method: 'POST' });
  if (!res.ok) await throwApiError(res);
}

// Distinguishes kicked (can rejoin by code) from banned (cannot) after a
// removed bounce — same endpoint the web RemovedView uses.
export async function getRemovedState(code: string): Promise<'banned' | 'kicked' | 'none'> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/removed-state`);
  if (!res.ok) return 'none';
  const j = await res.json().catch(() => null);
  return j?.state === 'banned' || j?.state === 'kicked' ? j.state : 'none';
}

export async function joinMoment(code: string, displayName: string): Promise<{ code: string }> {
  const res = await apiFetch('/api/session/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}
