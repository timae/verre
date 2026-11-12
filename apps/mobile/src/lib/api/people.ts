import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';

// People (You profile, the People step): someone's Friends / Followers /
// Following lists, the people search and "People you tasted with". Wire types
// MIRROR lib/profilePeople.ts, app/api/users/search/route.ts and
// app/api/me/tasted-with/route.ts — keep in sync by hand.

// One listed person. `imageUrl` follows THEIR account visibility (null when
// it hides their profile from you: initials); `momentsTogether` /
// `friendsInCommon` are null on your own row, `friendsInCommon` also when
// their visibility hides their profile from you.
export type PersonRow = {
  id: number;
  name: string;
  imageUrl: string | null;
  isFollowing: boolean;
  followsViewer: boolean;
  viewerMutes?: boolean;
  momentsTogether: number | null;
  friendsInCommon: number | null;
};

export type PeopleTab = 'friends' | 'followers' | 'following';
// A route's `tab` param (presentation only): anything else is Friends.
export function peopleTab(raw: string | undefined): PeopleTab {
  return raw === 'followers' || raw === 'following' ? raw : 'friends';
}
export type PeoplePage = { users: PersonRow[]; nextCursor: string | null; knownCount?: number };

// A 404 = the list is no longer yours to see (their visibility tightened, a
// block): the screen's terminal state, not an error.
export class PeopleGoneError extends Error {}

// Friends = followers with a follow back (the server's `mutual=mutual`).
export async function getPeoplePage(
  id: number,
  tab: PeopleTab,
  { known, q, cursor }: { known?: boolean; q?: string; cursor?: string | null } = {},
): Promise<PeoplePage> {
  const qs = new URLSearchParams();
  if (tab === 'friends') qs.set('mutual', 'mutual');
  if (known) qs.set('known', '1');
  if (q) qs.set('q', q);
  if (cursor) qs.set('cursor', cursor);
  const dir = tab === 'following' ? 'following' : 'followers';
  const res = await apiFetch(`/api/users/${id}/${dir}?${qs}`);
  if (res.status === 404) throw new PeopleGoneError();
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// ['people', id, tab, known, q]: every list page of one person shares the
// prefix ['people', id], and every list ['people'].
export const PEOPLE_KEY = ['people'] as const;
export function peopleKey(id: number, tab: PeopleTab, known: boolean, q: string) {
  return ['people', id, tab, known, q] as const;
}

// GET /api/users/search — the first ten names matching `q` (≥ 2 characters).
// A stub (their visibility hides the profile) carries `gated` and no photo.
export type SearchPerson = PersonRow & { gated?: true };
export const SEARCH_KEY = ['people-search'] as const;
export async function searchPeople(q: string): Promise<SearchPerson[]> {
  const res = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// GET /api/me/tasted-with — up to 8 people who share a moment with you and
// whom you don't follow, latest shared moment first. `lastMoment.name` is null
// for a nameless old moment.
export type TastedWith = {
  id: number;
  name: string;
  imageUrl: string | null;
  followsViewer: boolean;
  lastMoment: { name: string | null; at: string };
};
export const TASTED_WITH_KEY = ['tasted-with'] as const;
export async function getTastedWith(): Promise<TastedWith[]> {
  const res = await apiFetch('/api/me/tasted-with');
  if (!res.ok) await throwApiError(res);
  return (await res.json()).people;
}
