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
  // Server-computed Moments-home routing — TWO orthogonal signals (see
  // app/api/me/sessions/route.ts "Moments-home routing" for the full model):
  // - `status` ('live' | 'upcoming' | 'past') drives the LISTS: the had-list
  //   shows `!== 'upcoming'`, the Upcoming row shows `=== 'upcoming'`.
  // - `pinned` drives the CAROUSEL alone, INDEPENDENT of status. It's true for
  //   every live moment AND for an upcoming one visited <1h ago — so an
  //   upcoming+pinned moment shows in the carousel AND the Upcoming row at once.
  status: 'live' | 'upcoming' | 'past';
  pinned: boolean;
  cover_photo_url: string | null;
};

// Carousel-card label, derived client-side (not sent): "Happening now" only
// when the moment is dated AND has actually started; otherwise "Just visited"
// (a date-less live card, or an upcoming+pinned one that hasn't begun — we
// can't claim a not-yet-started moment is happening now).
export const liveKind = (r: MySessionRow): 'scheduled' | 'recent' => {
  const startsAt = r.date_from ? new Date(r.date_from).getTime() : null;
  const started = startsAt !== null && Date.now() >= startsAt;
  // date_to without date_from is treated as started (the window is open now).
  const hasOpenEnd = !r.date_from && !!r.date_to;
  return started || hasOpenEnd ? 'scheduled' : 'recent';
};

export const isLiveSession = (r: MySessionRow) => r.status === 'live';
export const isUpcomingSession = (r: MySessionRow) => r.status === 'upcoming';
// Carousel membership — the `pinned` signal, NOT `status` (an upcoming moment
// can be pinned). Use this for the highlight strip, never `isLiveSession`.
export const isPinnedSession = (r: MySessionRow) => r.pinned;

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
  // Spread from the server SessionMeta (lib/session.ts) via buildMetaView's
  // `{ ...meta }` — present whenever the host set a cover. Used by the 02f
  // Moment-details settings sheet to preview/replace/remove the cover.
  coverPhotoUrl?: string;
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

export type RateBody = {
  wineId: string;
  score: number; // 0..5 in 0.25 steps; 0 = not rated
  flavors: Record<string, number>; // whole steps 1..5, zero levels omitted
  notes: string;
};

// Upserts the caller's rating. Server side-effects (no client work):
// Postgres archival, the feed_item on first engagement, and the
// engagement-deletion cascade when score+flavors+notes are all empty —
// so "clear my rating" is just an empty rate POST.
export async function rateWine(code: string, body: RateBody): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
}

// Saved-wine ids for the Crave toggle — same shape the web SessionShell
// consumes ([{ wine_id }] from /api/me/bookmarks).
export async function getBookmarkedWineIds(): Promise<Set<string>> {
  const res = await apiFetch('/api/me/bookmarks');
  if (!res.ok) await throwApiError(res);
  const rows: Array<{ wine_id: string }> = await res.json();
  return new Set(rows.map((r) => r.wine_id));
}

export async function setBookmark(code: string, wineId: string, on: boolean): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/bookmark`,
    { method: on ? 'POST' : 'DELETE' },
  );
  if (!res.ok) await throwApiError(res);
}

export type CreateMomentBody = {
  hostDisplayName: string;
  sessionName?: string;
  category?: 'wine'; // v1 allow-list — widens with future category sets
  coverPhoto?: string; // base64 data URL; server runs the hardened image pipeline
  dateFrom?: string;
  dateTo?: string;
  timezone?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  address?: string;
  description?: string;
  link?: string;
  blind?: boolean; // pro-gated server-side
  // No lifespan: native creates default to 'unlimited' server-side (keyed on
  // the Better Auth session — the unspoofable caller class).
};

export async function createMoment(body: CreateMomentBody): Promise<{ code: string }> {
  const res = await apiFetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// 02f settings edit. Host-only PATCH; every field is optional — send only
// what changed. The server (app/api/session/[code]/settings) shares the detail
// validators with create via lib/sessionFields.ts, pro-gates blind + lifespan,
// and runs the hardened image pipeline on coverPhoto. coverPhoto: null removes
// the cover (reclaims the prior S3 bytes); a data URL replaces it. Mobile never
// sends lifespan (native creates stay 'unlimited' — create parity).
export type MomentSettingsBody = {
  name?: string;
  address?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  timezone?: string;
  description?: string;
  link?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  blind?: boolean; // pro-gated server-side
  blindForEveryone?: boolean;
  coverPhoto?: string | null; // data URL = replace; null = remove
};

export async function updateMomentSettings(code: string, body: MomentSettingsBody): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
}

// Soft-deletes the moment (host/cohost-gated server-side). Bounces every
// participant on their next poll (the session 404s). Irreversible from the UI.
export async function deleteMoment(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

// Hide / un-hide a moment from the home highlight carousel (personal view
// pref; it stays in "All moments"). Re-engaging (visit/rate) auto-un-hides.
export async function setMomentHidden(code: string, hidden: boolean): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/carousel-hidden`, {
    method: hidden ? 'POST' : 'DELETE',
  });
  if (!res.ok) await throwApiError(res);
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

// People-management actions (host/cohost). The server is the authority on the
// tier gates (cohost role = strict-host only; banning a cohost = strict-host;
// provider ⊥ cohost) — the People UI mirrors them only to avoid offering dead
// actions, and surfaces the server's 403 message if a race slips through.

// Set a participant's role. 'taster' clears cohost/provider. The wire role
// values are snake_case to match the backend (PATCH /api/session/:code).
export type WireRole = 'taster' | 'co_host' | 'provider';
export async function setParticipantRole(code: string, targetId: string, role: WireRole): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-role', targetId, role }),
  });
  if (!res.ok) await throwApiError(res);
}

// Kick (can rejoin) or ban (cannot) a participant. Ban deletes their data;
// deleteAddedWines additionally removes wines they added (default false).
export async function removeParticipant(
  code: string,
  identityId: string,
  mode: 'kick' | 'ban',
  deleteAddedWines = false,
): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/bans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityId, mode, deleteAddedWines }),
  });
  if (!res.ok) await throwApiError(res);
}
