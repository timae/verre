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
// Phase 1 renders this minimally — the redesign is Phase 2 (proposal §5).
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
  venueName: string | null;
  city: string | null;
  country: string | null;
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

export { ApiError };
