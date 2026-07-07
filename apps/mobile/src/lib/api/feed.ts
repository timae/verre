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
// authoritative liked state; the caller reconciles its optimistic write.
export async function setFeedItemLike(feedItemId: number, liked: boolean): Promise<void> {
  const res = await apiFetch(`/api/feed-items/${feedItemId}/like`, {
    method: liked ? 'POST' : 'DELETE',
  });
  if (!res.ok) await throwApiError(res);
}

// A stable id for a feed item across the checkin/session split — used as
// the FlatList key and the like-mutation target (both carry feed_items.id).
export function feedItemId(item: FeedItem): number {
  return item.type === 'checkin' ? item.checkin.id : item.session.id;
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

// The detail screen's uniform wine list + author + whether it's a moment (dots
// + "#N of M") or a standalone (single, no dots). A standalone's check-in maps
// onto SessionFeedWine (it lacks region/vinification/description/purchaseUrl —
// those are session-wine catalog fields the checkin payload omits, so the About
// block renders only what's present: country + grape).
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
  const wine: SessionFeedWine = {
    id: String(c.id),
    name: c.wineName,
    producer: c.producer,
    vintage: c.vintage,
    grape: c.grape,
    type: c.type,
    imageUrl: c.imageUrl,
    score: c.score,
    flavors: c.flavors,
    notes: c.notes,
    // The WINE's origin (not the venue country) → About "Origin" row.
    region: c.wineRegion,
    country: c.wineCountry,
    vinification: c.vinification,
    description: c.description,
    purchaseUrl: c.purchaseUrl,
  };
  // A standalone has no moment — the "where" is the venue.
  return {
    author: item.author,
    wines: [wine],
    isSession: false,
    createdAt: item.createdAt,
    verb: 'had a wine',
    place: [c.venueName, c.city].filter(Boolean).join(', ') || null,
    momentName: null,
    sessionId: null,
  };
}

export { ApiError };
