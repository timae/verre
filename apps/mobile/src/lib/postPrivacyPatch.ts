import { effectivePrivacy, type PrivacyField } from './postPrivacyState';

// Your own posts' switches on the feed's items (Moment Visibility step 3, § 5).
// Pure, and STRUCTURAL on purpose (a FeedItem fits, lib/listPost.ts's rule):
// the root units import this module, and the app's API types would pull React
// Native's typings into the web's type-check.
type SessionPost = { id: number; sessionId: number | null; onlyInside?: boolean; hiddenFromFeed?: boolean; privacyAt?: number };
type CheckinPost = { id: number; hiddenFromFeed?: boolean; privacyAt?: number };
export type PrivacyTarget = { type: 'session'; session: SessionPost } | { type: 'checkin'; checkin: CheckinPost };

// The feed cache patch. Only a post that CARRIES the field (your own, with its
// flag on) is touched; anything else comes back as the same object, so
// `updateFeedCaches` keeps it. `sessionId` matches every moment post of that
// moment (the Moment Privacy page's write), `postId` one post. A moment post
// carries both fields (Incognito, Hide from Feed: R11, R12), a check-in only
// Hide from Feed.
export function withPrivacy<T extends PrivacyTarget>(item: T, match: { postId?: number; sessionId?: number }, field: PrivacyField, value: boolean, at: number): T {
  const it = item as PrivacyTarget;
  if (it.type === 'session') {
    if (it.session[field] === undefined) return item;
    const hit = match.postId !== undefined ? it.session.id === match.postId : match.sessionId !== undefined && it.session.sessionId === match.sessionId;
    if (!hit) return item;
    return { ...it, session: { ...it.session, [field]: value, privacyAt: at } } as unknown as T;
  }
  if (field !== 'hiddenFromFeed' || it.checkin.hiddenFromFeed === undefined || match.postId === undefined || it.checkin.id !== match.postId) return item;
  return { ...it, checkin: { ...it.checkin, hiddenFromFeed: value, privacyAt: at } } as unknown as T;
}

// What a post's ⋯ row and status line read (empty = no row: someone else's
// post, or the flag is off). Hide from Feed only, on a moment post and a
// check-in alike: Incognito is a setting of the moment (its Moment Privacy
// page), never a post's row or line (ruled 2026-11-25, R13).
export type PostSwitch = { field: PrivacyField; on: boolean; postId: number; sessionId: number | null };
export function postPrivacyOf(item: PrivacyTarget | null | undefined): PostSwitch[] {
  if (!item) return [];
  const [id, served, at, sessionId] = item.type === 'session'
    ? [item.session.id, item.session.hiddenFromFeed, item.session.privacyAt, item.session.sessionId]
    : [item.checkin.id, item.checkin.hiddenFromFeed, item.checkin.privacyAt, null];
  const on = effectivePrivacy(id, 'hiddenFromFeed', served, at, sessionId);
  return on === undefined ? [] : [{ field: 'hiddenFromFeed', on, postId: id, sessionId: sessionId ?? null }];
}

// Your own posts' switches carry the time their request left (the own-post
// store's rule, lib/postPrivacyState.ts). Only posts that carry a switch.
export function stampPrivacy<P extends { items: PrivacyTarget[] }>(page: P, startedAt: number): P {
  return {
    ...page,
    items: page.items.map((it) => {
      if (it.type === 'session' && (it.session.onlyInside !== undefined || it.session.hiddenFromFeed !== undefined)) return { ...it, session: { ...it.session, privacyAt: startedAt } };
      if (it.type === 'checkin' && it.checkin.hiddenFromFeed !== undefined) return { ...it, checkin: { ...it.checkin, privacyAt: startedAt } };
      return it;
    }),
  };
}
