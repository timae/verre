import type { AromaSelection } from '@verre/core';
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
  postId: number | null; // the post you may open (null: none, or hidden from you: the row opens its impression page)
  wineId?: string; // absent on a blind row of someone else's list
  name: string;
  vintage: string | null;
  producer: string | null;
  type: string | null; // the legacy style token
  colour: string | null;
  sparkling: boolean;
  category: string;
  imageUrl: string | null;
  score: number | null;
  hadAt: string; // the post's time (a moment's ratings group together)
  blind?: true;
  momentName?: string;
  privateMoment?: true; // a live moment whose name you may not see (step 3b, R16): the line reads "Private Moment"
  yourScore?: number | null; // someone else's list only: your score of the same bottle
};
export type ImpressionsPage = { items: ImpressionRow[]; nextCursor: string | null; commonCount?: number };

// ONE impression for its page (Moment Visibility step 3, R4, T13): GET
// /api/users/:id/impressions/:ratingId, the row the list shows you plus the
// rating. Mirrors lib/profileLists.ts `ImpressionPage`. No post, no moment, no
// wine id on a blind or stripped row; 404 for every miss.
export type ImpressionPage = {
  id: number; // the rating
  author: { id: string; name: string; username: string | null; xp: number; imageUrl: string | null };
  wineId?: string;
  name: string;
  vintage: string | null;
  producer: string | null;
  type: string | null;
  colour: string | null;
  sparkling: boolean;
  category: string;
  abv: number | null;
  grape: string | null;
  region: string | null;
  country: string | null;
  imageUrl: string | null;
  score: number | null;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  notes: string | null;
  description: string | null;
  vinification: string | null;
  purchaseUrl: string | null;
  hadAt: string;
  blind?: true;
};
// 🔒 OUTSIDE ['feed', …] (T13): the feed cache patch maps every ['feed'] entry.
export const impressionKey = (owner: string, ratingId: number) => ['impression', owner, ratingId] as const;
export function getImpression(owner: string, ratingId: number): Promise<ImpressionPage> {
  return get(`/api/users/${encodeURIComponent(owner)}/impressions/${ratingId}`);
}

export type CravingRow = {
  // Your own rows: the remove handle (`DELETE /api/me/bookmarks/:key`: the
  // craving's id, or `m` + a blind save's id). 🔒 Absent on someone else's
  // list (a bookmark id is a coarse save time): key those rows on their place
  // in the page (catalogue model change step 5).
  key?: string;
  // The row's bottle, while there is one (the post link pairs it with postId).
  wineId?: string;
  postId: number | null; // the list owner's post of it, when they rated it
  // The rating that post and the score come from: the post's row to open, or
  // the impression's page when there is no post you may open (Moment
  // Visibility step 3, T14). Since step 5 it can be another bottle of the same wine.
  ratingId?: number;
  name: string;
  vintage: string | null;
  producer: string | null;
  colour: string | null;
  sparkling: boolean;
  imageUrl: string | null;
  score: number | null; // the list owner's score (theirs only through their post visibility)
  momentName?: string;
};
export type CravingsPage = { items: CravingRow[]; nextCursor: string | null };
export type CravingsSort = 'recent' | 'score';

// Someone's Moments (D5; Moment Visibility step 1b + step-2 plan § 4.3): a
// moment you SHARE (you were there: its code, you open the moment itself), or,
// with the feature on, one you may only LOOK INTO (its public id, no code: you
// open the look-in). Both: the moment's own fields + THEIR role. An open row's
// `name` is null for a nameless moment whose host is hidden from you, and it
// carries `address` only when the host shows the place.
type MomentRowFields = {
  name: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  createdAt: string | null;
  coverPhotoUrl: string | null;
  category: string | null;
  role: 'host' | 'cohost' | 'provider' | null;
};
export type SharedMomentRow =
  | (MomentRowFields & { code: string; momentId?: never; address: string | null })
  | (MomentRowFields & { momentId: string; code?: never; address?: string | null });
export type SharedMomentsPage = { items: SharedMomentRow[]; nextCursor: string | null; otherCount?: number };

// A 404 = the list is no longer yours to see (gone, private, a block): the
// screen's terminal state, not an error.
export class ListGoneError extends Error {}

// Mirrors lib/impressionsCursor.ts ImpressionSort (newest = the server's default).
export type ImpressionSort = 'newest' | 'oldest' | 'highest' | 'lowest';
export type AromaMode = 'all' | 'any';
export type ImpressionParams = {
  q?: string; from?: string | null; to?: string | null; category?: string; min?: number | null; max?: number | null;
  /** Structure ranges by axis key: whole 0..5 (0 = None), lo ≤ hi. */
  structure?: Record<string, readonly [number, number]>;
  aromas?: AromaSelection[]; aromaMode?: AromaMode;
  common?: boolean; sort?: ImpressionSort;
};
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
  // Structure ranges (`sweet:1-3,tannin:0-0`, sorted by key so the same
  // ranges always make the same URL), aroma picks as the stored selection
  // shape (each read broad, server-side).
  const st = Object.entries(p.structure ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, [lo, hi]]) => `${k}:${lo}-${hi}`);
  if (st.length) qs.set('st', st.join(','));
  if (p.aromas?.length) {
    qs.set('ar', JSON.stringify(p.aromas));
    if (p.aromaMode === 'any' && p.aromas.length > 1) qs.set('armode', 'any');
  }
  if (p.sort && p.sort !== 'newest') qs.set('sort', p.sort);
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
