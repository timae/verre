import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';

// The profile tile lists (lists plan D10): someone's (or your own)
// Impressions, Moments and Cravings. Wire types MIRROR lib/profileLists.ts —
// keep in sync by hand. Your own Moments read /api/me/sessions instead
// (lib/api/sessions.ts getMomentsPage, `tense` omitted).
//
// Blind rows (`blind: true`) carry no name / producer / vintage / photo: the
// row renders "Blind Impression". A list whose owner hides it from you (posts
// hidden, a Show switch off) is a 200 EMPTY page with no counts.

export type ImpressionRow = {
  id: number; // the rating
  postId: number | null; // the post it belongs to (null: none, inert)
  wineId: string;
  name: string;
  vintage: string | null;
  producer: string | null;
  type: string | null;
  category: string;
  imageUrl: string | null;
  score: number | null;
  hadAt: string; // the post's time (a moment's ratings group together)
  blind?: true;
  momentName?: string;
  yourScore?: number | null; // someone else's list only: your score of the same bottle
};
export type ImpressionsPage = { items: ImpressionRow[]; nextCursor: string | null; commonCount?: number };

export type CravingRow = {
  key?: string; // your own rows: the remove key (the wine id today)
  wineId: string;
  postId: number | null; // the list owner's post of it, when they rated it
  name: string;
  vintage: string | null;
  producer: string | null;
  type: string | null;
  imageUrl: string | null;
  score: number | null; // the list owner's score (theirs only through their post visibility)
  blind?: true;
  momentName?: string;
};
export type CravingsPage = { items: CravingRow[]; nextCursor: string | null };
export type CravingsSort = 'recent' | 'score';

// Someone's moment you share (D5): the moment's own fields + THEIR role.
export type SharedMomentRow = {
  code: string;
  name: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  createdAt: string | null;
  address: string | null;
  coverPhotoUrl: string | null;
  category: string | null;
  role: 'host' | 'cohost' | 'provider' | null;
};
export type SharedMomentsPage = { items: SharedMomentRow[]; nextCursor: string | null; otherCount?: number };

// A 404 = the list is no longer yours to see (gone, private, a block): the
// screen's terminal state, not an error.
export class ListGoneError extends Error {}

export type ImpressionParams = { q?: string; from?: string | null; to?: string | null; category?: string; min?: number | null; max?: number | null; common?: boolean };
export type SharedMomentParams = { q?: string; roles?: string[]; hosts?: string[]; people?: string[]; category?: string; from?: string | null; to?: string | null };

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (res.status === 404) throw new ListGoneError();
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export function getImpressionsPage(id: string, p: ImpressionParams, cursor: string | null): Promise<ImpressionsPage> {
  const qs = new URLSearchParams();
  if (p.q) qs.set('q', p.q);
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.category && p.category !== 'any') qs.set('category', p.category);
  if (p.min != null) qs.set('min', String(p.min));
  if (p.max != null) qs.set('max', String(p.max));
  if (p.common) qs.set('common', '1');
  if (cursor) qs.set('cursor', cursor);
  return get(`/api/users/${encodeURIComponent(id)}/impressions?${qs}`);
}

export function getCravingsPage(id: string, p: { q?: string; sort: CravingsSort }, cursor: string | null): Promise<CravingsPage> {
  const qs = new URLSearchParams();
  if (p.q) qs.set('q', p.q);
  if (p.sort === 'score') qs.set('sort', 'score');
  if (cursor) qs.set('cursor', cursor);
  return get(`/api/users/${encodeURIComponent(id)}/cravings?${qs}`);
}

export function getSharedMomentsPage(id: string, p: SharedMomentParams, cursor: string | null): Promise<SharedMomentsPage> {
  const qs = new URLSearchParams();
  if (p.q?.trim()) qs.set('q', p.q.trim());
  if (p.roles?.length) qs.set('roles', p.roles.join(','));
  if (p.hosts?.length) qs.set('hosts', p.hosts.join(','));
  if (p.people?.length) qs.set('people', p.people.join(','));
  if (p.category && p.category !== 'any') qs.set('category', p.category);
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (cursor) qs.set('cursor', cursor);
  qs.set('limit', '30');
  return get(`/api/users/${encodeURIComponent(id)}/moments?${qs}`);
}

// DELETE /api/me/bookmarks/:key — remove a craving (D8; idempotent).
export async function removeCraving(key: string): Promise<void> {
  const res = await apiFetch(`/api/me/bookmarks/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

// ['profile-list', kind, id, params] (infinite). Not feed caches, but refreshed
// IN PLACE too (D12): cancel, then refetch; never blanked.
export type ListKind = 'impressions' | 'moments' | 'cravings';
export const PROFILE_LIST_KEY = ['profile-list'] as const;
export function profileListKey(kind: ListKind, id: string, params: unknown) {
  return ['profile-list', kind, id, params] as const;
}
