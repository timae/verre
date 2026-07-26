import { infiniteQueryOptions } from '@tanstack/react-query';
import type { AromaSelection } from '@verre/core';
import { apiFetch } from '../apiFetch';
import { ApiError, throwApiError } from './sessions';

// Typed fetchers + wire types for the social feed (`/api/feed`).
// Wire types MIRROR the server's emitted shape in app/api/feed/route.ts
// (the OutgoingItem union) + lib/feedTypes.ts (SessionFeedWine/Payload).
// Keep in sync — the server is the source of truth; this hand-mirrors it
// per the web↔native wire-type convention.

// The author byline on every feed item.
export type FeedAuthor = {
  id: number;
  name: string;
  xp: number;
  imageUrl: string | null;
};

// One wine inside a session feed card — mirrors lib/feedTypes.ts
// SessionFeedWine. Blind-redacted wines arrive with `_blind: true` and
// blanked identity + metadata (name === '', producer/region/etc null).
export type SessionFeedWine = {
  id: string;
  name: string;
  producer: string | null;
  vintage: string | null;
  grape: string | null;
  type: string | null;
  imageUrl: string | null;
  score: number | null;
  flavors: Record<string, number>;
  // Aroma descriptor selections — the author's own perception, shipped
  // unredacted even on a `_blind` wine (aroma-layer.md §7), like flavors.
  aromas: AromaSelection[];
  notes: string | null;
  // Catalog metadata for the full impression detail page. Blanked (null)
  // on a blind-redacted wine — never render identity off a `_blind` wine.
  region: string | null;
  country: string | null;
  vinification: string | null;
  description: string | null;
  purchaseUrl: string | null;
  _blind?: boolean;
};

// A standalone check-in ("<name> had a wine"). One impression, one photo.
export type CheckinPayload = {
  id: number; // feed_items.id
  wineName: string;
  producer: string | null;
  vintage: string | null;
  grape: string | null;
  type: string | null;
  score: number | null;
  notes: string | null;
  imageUrl: string | null;
  // VENUE location (where they had it) — the header line venueName · city.
  // `country` is the venue country, NOT the wine's origin.
  venueName: string | null;
  city: string | null;
  country: string | null;
  // WINE catalog metadata for the detail "About this impression" block —
  // `wineRegion`/`wineCountry` are the wine's ORIGIN (distinct from `country`,
  // the venue). Parity with SessionFeedWine so a standalone detail page shows
  // the same About table.
  wineRegion: string | null;
  wineCountry: string | null;
  vinification: string | null;
  description: string | null;
  purchaseUrl: string | null;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  likeCount: number;
  createdAt: string;
  tags: { id: number; name: string }[];
  liked: boolean;
  viewerFollowsAuthor: boolean;
};

// A session-aggregate post ("<name> shared a moment") — mirrors
// lib/feedTypes.ts SessionFeedPayload. Tombstoned sessions ship
// sessionName/hostName === null + deleted === true; the wine list still
// renders ("[deleted session]" header).
export type SessionFeedPayload = {
  id: number; // feed_items.id
  sessionId: number | null;
  sessionName: string | null;
  hostName: string | null;
  deleted: boolean;
  blind: boolean;
  wines: SessionFeedWine[];
  likeCount: number;
  liked: boolean;
};

export type FeedItem =
  | { type: 'checkin'; createdAt: string; author: FeedAuthor; checkin: CheckinPayload }
  | { type: 'session'; createdAt: string; author: FeedAuthor; session: SessionFeedPayload };

export type FeedPage = {
  items: FeedItem[];
  nextCursor: string | null;
};

// GET /api/feed?cursor=<ISO> — the caller's network feed, newest first,
// cursor-paginated (PAGE=20 server-side). No cursor = from now.
export async function getFeed(cursor?: string | null): Promise<FeedPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const res = await apiFetch(`/api/feed${qs}`);
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as FeedPage;
}

// POST|DELETE /api/feed-items/:id/like — toggle the like. Returns the
// AUTHORITATIVE { liked, count } (idempotency + block-pair like hiding are
// applied server-side, so the real count can diverge from ±1 client math);
// the caller reconciles its optimistic write with it.
export async function setFeedItemLike(
  feedItemId: number,
  liked: boolean,
): Promise<{ liked: boolean; count: number }> {
  const res = await apiFetch(`/api/feed-items/${feedItemId}/like`, {
    method: liked ? 'POST' : 'DELETE',
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { liked: boolean; count: number };
}

// POST /api/checkins — create a standalone check-in (the mobile create form;
// later "Had it too" rides the same call with copyFromCheckinId). Body mirrors
// the route's accepted fields (app/api/checkins/route.ts) minus taggedUserIds +
// lat/lng (tagging + map UX are their own passes). `flavors` must be the
// filled-or-empty shape (fillFlavourZeros) — the server 400s stray off-style
// keys. `imageData` is a base64 data URL; keep it under MAX_COVER_BYTES
// (~2MB decoded). Oversize behavior is SPLIT server-side: above the route's
// 3MB-encoded cap it 400s "image too large", but between ~2MB decoded and
// that cap uploadImage() returns '' and the check-in saves with NO image,
// silently — MAX_COVER_BYTES stays under both.
// The response (a legacy checkin envelope) is not consumed — callers surface
// the new post via a feed refetch()-in-place instead.
export type CreateCheckinBody = {
  wineName: string;
  producer?: string;
  vintage?: string; // a 4-digit year OR the "NV" token; the server canonicalizes
  //                    (exactly-4-digits-or-NV, else empty) — it does NOT truncate
  grape?: string; // design "Variety"
  type?: string; // WineTypeCode; unknown values coerce to null server-side
  // WINE-origin metadata, landed on the minted wine row (the About block).
  // wineRegion/wineCountry are named apart from `country` (the VENUE country)
  // — the same split the feed payload makes.
  wineRegion?: string;
  wineCountry?: string; // ISO-2; invalid codes drop server-side
  vinification?: string; // design "Process"
  description?: string;
  purchaseUrl?: string; // http(s)-only server-side (cleanUrl)
  score: number; // 0 = not rated
  flavors: Record<string, number>;
  // Canonical AromaSelection[] (AromaInput keeps it gated client-side); the
  // server re-gates via gateAromas and 400s unknown ids / bad modifiers.
  // Omitted = [] on create (present-replaces / omitted-preserves contract).
  aromas?: AromaSelection[];
  notes?: string;
  imageData?: string;
  venueName?: string;
  city?: string;
  country?: string; // VENUE country, ISO-2
  copyFromCheckinId?: number;
};

export async function createCheckin(body: CreateCheckinBody): Promise<void> {
  const res = await apiFetch('/api/checkins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
}

// ── Feed-post editing (2026-07-17) ───────────────────────────────────────────
// Both kinds PATCH /api/checkins/:feedItemId (one edit chokepoint server-side;
// the route branches on the feed item's kind). Partial semantics: omitted
// fields preserve; aromas are present-replaces (send the full list).

// Standalone: wine metadata + rating. Everything optional — send what changed
// (or the full truth; the server treats both the same).
export type PatchCheckinBody = Partial<Omit<CreateCheckinBody, 'copyFromCheckinId' | 'imageData'>> & {
  // A fresh data URL replaces the photo; null removes it; omitted keeps it.
  imageData?: string | null;
};

// The standalone PATCH echo — the fields the edit screen maps back into the
// cached CheckinPayload (engagement fields like likeCount/tags/liked are
// untouched by an edit and keep their cached values).
export type PatchCheckinResponse = {
  id: number;
  wineName: string;
  producer: string | null;
  vintage: string | null;
  grape: string | null;
  type: string | null;
  wineRegion: string | null;
  wineCountry: string | null;
  vinification: string | null;
  description: string | null;
  purchaseUrl: string | null;
  score: number | null;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  notes: string | null;
  imageUrl: string | null;
  venueName: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
};

export async function patchCheckin(feedItemId: number, body: PatchCheckinBody): Promise<PatchCheckinResponse> {
  const res = await apiFetch(`/api/checkins/${feedItemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// Session kind: RATING-ONLY (the wine belongs to the moment). An edit that
// empties the rating reaps it server-side — `reaped` + `feedItemDeleted`
// (true when it was the caller's last engaged rating in that session) tell
// the client whether the post itself is gone.
export type PatchSessionRatingBody = {
  wineId: string;
  score?: number;
  flavors?: Record<string, number>;
  aromas?: AromaSelection[];
  notes?: string;
};

export type PatchSessionRatingResponse = {
  id: number;
  wineId: string;
  score: number | null;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  notes: string | null;
  reaped: boolean;
  feedItemDeleted: boolean;
};

export async function patchSessionRating(feedItemId: number, body: PatchSessionRatingBody): Promise<PatchSessionRatingResponse> {
  const res = await apiFetch(`/api/checkins/${feedItemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// DELETE /api/checkins/:id — delete an owned STANDALONE check-in (the post,
// its rating, and its photo; the server reclaims S3 after commit). Session
// posts are never deleted directly — clearing the rating via
// patchSessionRating reaps them when they empty out.
export async function deleteCheckin(feedItemId: number): Promise<void> {
  const res = await apiFetch(`/api/checkins/${feedItemId}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

// A stable id for a feed item across the checkin/session split — used as
// the FlatList key and the like-mutation target (both carry feed_items.id).
export function feedItemId(item: FeedItem): number {
  return item.type === 'checkin' ? item.checkin.id : item.session.id;
}

// The ONE definition of the feed infinite query, consumed by the list screen
// AND the detail screen. The detail is a pure render off the same cache — that
// only holds while both observers attach with the identical key/options, so
// the definition lives here (with the fetcher + wire types), not copy-pasted
// per screen.
export const FEED_KEY = ['feed'] as const;
export const FEED_STALE_MS = 15_000;
export function feedQueryOptions() {
  return infiniteQueryOptions({
    queryKey: FEED_KEY,
    queryFn: ({ pageParam }) => getFeed(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: FEED_STALE_MS,
  });
}

// The impression detail screen (proposal 08 §3) is a PURE client render off the
// data the feed already delivered — no new fetch. It reads the ['feed'] infinite
// cache, finds the post by feed_item id, and normalises both variants into ONE
// list of wines to page over: a session → its wines[]; a standalone check-in →
// a single synthesized wine (so the pager/hero speak one shape). Returns null
// when the post isn't in the cache (e.g. deep-linked before the feed loaded, or
// scrolled out of a trimmed cache) — the screen shows a terminal "gone" state.
export function findFeedItem(pages: FeedPage[] | undefined, id: number): FeedItem | null {
  for (const page of pages ?? []) {
    for (const item of page.items) if (feedItemId(item) === id) return item;
  }
  return null;
}

// Adapt a standalone check-in into the SessionFeedWine shape the shared feed
// surfaces (glass panel, heroes, detail pager) speak. ONE adapter — used by
// both StandaloneFeedCard and detailFromItem below — so the card and the
// detail page can never disagree about the same check-in. A standalone is
// never blind (the author's own public post); the payload carries the full
// wine-catalog metadata, so the About block matches a session wine's.
export function checkinToWine(c: CheckinPayload): SessionFeedWine {
  return {
    id: String(c.id),
    name: c.wineName,
    producer: c.producer,
    vintage: c.vintage,
    grape: c.grape,
    type: c.type,
    imageUrl: c.imageUrl,
    score: c.score,
    flavors: c.flavors,
    aromas: c.aromas,
    notes: c.notes,
    // The WINE's origin (wineRegion/wineCountry) — NOT c.country, which is the
    // VENUE country (the old standalone card conflated them).
    region: c.wineRegion,
    country: c.wineCountry,
    vinification: c.vinification,
    description: c.description,
    purchaseUrl: c.purchaseUrl,
  };
}

// The detail screen's uniform wine list + author + whether it's a moment (dots
// + "#N of M") or a standalone (single, no dots). A standalone's check-in maps
// onto SessionFeedWine via checkinToWine above.
export function detailFromItem(item: FeedItem): {
  author: FeedAuthor;
  wines: SessionFeedWine[];
  isSession: boolean;
  createdAt: string; // the post time (from the FeedItem wrapper)
  // The header's "where" line: a session → "shared a moment" + the moment name;
  // a standalone → "had a wine" + the venue (venueName · city).
  verb: string;
  place: string | null;
  // Attribution: the moment this came from (session posts only). `momentName`
  // is null for a tombstoned moment; `sessionId` drives the enter-moment match
  // against the viewer's own sessions (never a join code on the wire).
  momentName: string | null;
  sessionId: number | null;
} {
  if (item.type === 'session') {
    const momentName = item.session.deleted ? null : item.session.sessionName;
    return {
      author: item.author,
      wines: item.session.wines,
      isSession: true,
      createdAt: item.createdAt,
      verb: 'shared a moment',
      place: item.session.deleted ? '[deleted moment]' : momentName,
      momentName,
      sessionId: item.session.sessionId,
    };
  }
  const c = item.checkin;
  // A standalone has no moment — the "where" is the venue.
  return {
    author: item.author,
    wines: [checkinToWine(c)],
    isSession: false,
    createdAt: item.createdAt,
    verb: 'had a wine',
    place: [c.venueName, c.city].filter(Boolean).join(', ') || null,
    momentName: null,
    sessionId: null,
  };
}

export { ApiError };
