import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';

// Typed fetchers + wire types for a person's profile header (the You profile,
// 04 step 1) and the relationship writes behind its buttons and ⋯ menu.
// Wire types MIRROR app/api/users/[id]/route.ts (+ lib/profileLoad.ts and
// lib/profileHeader.ts) for `?view=header` — keep in sync by hand.

export type ProfileTile = { count: number; imageUrl: string | null };
export type ProfileFace = { id: number; name: string; imageUrl: string | null };

// The full (`ok`) payload: the viewer may see this person's content.
export type FullProfile = {
  state: 'ok';
  id: number;
  name: string;
  imageUrl: string | null;
  // Our level names (lib/badges.ts LEVELS: Novice, Enthusiast, …) — the
  // status pill (Simon's ruling: the design's names were placeholders).
  level: { name: string };
  // avgScore: the 1-decimal average of their scores; null = nothing rated yet.
  flavor: { avgScore: number | null };
  stats: { followers: number; following: number };
  friendsCount: number;
  isFollowing: boolean;
  // The profile owner follows the viewer ("Follow Back").
  followsYou: boolean;
  viewerMutes: boolean;
  // Absent on your own profile.
  inCommon?: { count: number; faces: ProfileFace[] };
  tiles: { impressions: ProfileTile; moments: ProfileTile; cravings: ProfileTile };
};

export type Profile =
  | FullProfile
  // Tier-gated ("private"): exists, but the viewer can't see content.
  | { state: 'shell'; id: number; name: string; isFollowing: boolean }
  // The viewer blocked them: name only, so they recognise who it is.
  | { state: 'blocked'; id: number; name: string }
  // No such user — OR they blocked the viewer (deliberately indistinguishable).
  | { state: 'gone'; id: number };

// GET /api/users/:id?view=header — the header only (the posts come from
// /api/feed?user=). A 404 is a state, not an error: it renders the gone view.
export async function getProfile(id: number): Promise<Profile> {
  const res = await apiFetch(`/api/users/${id}?view=header`);
  if (res.status === 404) return { state: 'gone', id };
  if (!res.ok) await throwApiError(res);
  const body = await res.json();
  if (body.blocked) return { state: 'blocked', id, name: body.name };
  if (body.gated) return { state: 'shell', id, name: body.name, isFollowing: !!body.isFollowing };
  return { ...(body as Omit<FullProfile, 'state'>), state: 'ok' };
}

export function profileKey(id: number) {
  return ['user-profile', id] as const;
}

export function profileQueryOptions(id: number) {
  return queryOptions({
    queryKey: profileKey(id),
    queryFn: () => getProfile(id),
    staleTime: 15_000,
  });
}

// Relationship writes. Each resolves on success; failures throw ApiError
// (429s carry the server's "Try again in …" copy).
async function send(path: string, method: 'POST' | 'DELETE'): Promise<void> {
  const res = await apiFetch(path, { method });
  if (!res.ok) await throwApiError(res);
}

// POST/DELETE /api/users/:id/follow — a target who blocked you answers a
// silent 200 (no oracle), so the refetched profile is the truth afterwards.
export const setFollowing = (id: number, on: boolean) => send(`/api/users/${id}/follow`, on ? 'POST' : 'DELETE');
// POST/DELETE /api/me/mutes/:id — mute hides them from YOUR network feed only.
export const setMuted = (id: number, on: boolean) => send(`/api/me/mutes/${id}`, on ? 'POST' : 'DELETE');
// POST/DELETE /api/me/blocks/:id — bilateral invisibility (docs/dev/block.md).
export const setBlocked = (id: number, on: boolean) => send(`/api/me/blocks/${id}`, on ? 'POST' : 'DELETE');
