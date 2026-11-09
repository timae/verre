import { createContext, useContext, useRef } from 'react';
import { useSegments } from 'expo-router';
import type { Href } from 'expo-router';

// The session sub-tree is mounted under THREE tab stacks (proposal 09 §B):
// Moments owns /(tabs)/moments/session/[code]; Feed and You mirror it at
// /(tabs)/feed/session/[code] and /(tabs)/you/session/[code] (thin re-export
// route files), so entering a moment from a post stays ON that stack and back
// returns to the post. (You mounts it because a profile lists posts too.) Every forward push INSIDE the sub-tree must therefore be
// stack-relative — a hardcoded /(tabs)/moments/... would silently hop a
// feed-stack visitor over to the Moments tab. Resolve the owning tab with
// useSessionTab() and build hrefs with sessionHref().

export type SessionTab = 'moments' | 'feed' | 'you';

// The owning tab, from where the CALLER IS MOUNTED: each tab's stack layout
// provides it (SessionTabProvider in moments/feed/you `_layout.tsx`), so a
// screen or list resolves its own stack even when it first renders in a
// background tab — e.g. a profile whose posts mount once the header query
// resolves after you switched tabs (Codex, 2026-11-09).
//
// Fallback (no provider — called somewhere unexpected): segments look like
// ['(tabs)', 'feed', 'session', '[code]', ...], the tab route group is the
// second; default 'moments' (the original home of the sub-tree). That is
// global "current route" state, not "the stack this instance is mounted in",
// so it is PINNED at first render: an EFFECT firing on a blurred background
// instance would otherwise resolve the FOREGROUND tab and bounce on the
// wrong stack. A mounted instance's owning stack can never change.
const SessionTabContext = createContext<SessionTab | null>(null);
export const SessionTabProvider = SessionTabContext.Provider;

export function useSessionTab(): SessionTab {
  const fromLayout = useContext(SessionTabContext);
  const segments = useSegments();
  const pinned = useRef<SessionTab | null>(null);
  if (pinned.current === null) {
    pinned.current = fromLayout ?? (segments[1] === 'feed' ? 'feed' : segments[1] === 'you' ? 'you' : 'moments');
  }
  return pinned.current;
}

type SessionSub =
  | ''
  | 'add'
  | 'settings'
  | 'settings/details'
  | 'settings/reveal'
  | 'impression/[wineId]'
  | 'edit-impression/[wineId]';

// The cast lives here and nowhere else: both variants are REAL routes (the
// mirror files make them so), but a computed pathname can't satisfy the
// typed-routes literal union.
export function sessionHref(
  tab: SessionTab,
  sub: SessionSub,
  params: { code: string; wineId?: string },
): Href {
  const pathname = `/(tabs)/${tab}/session/[code]${sub ? `/${sub}` : ''}`;
  return { pathname, params } as Href;
}

// The owning tab's home (used by e.g. the delete-moment bounce, so a
// feed-stack visitor lands back on Feed, not Moments).
export function tabHomeHref(tab: SessionTab): Href {
  return `/(tabs)/${tab}` as Href;
}

// ── Posts + profiles (the feed sub-tree) ─────────────────────────────────────
// The post detail, its edit screens and the profile screen are mounted under
// Feed AND You (You's are one-line re-export mirrors), so their pushes are
// stack-relative too. `user` on a post route names the list it came from: the
// detail/edit read and write THAT list's cache (lib/api/feed.ts feedKey) —
// absent = the network feed.
type FeedSub = 'impression/[id]' | 'edit/[id]' | 'edit/details' | 'u/[id]';
type FeedTab = Exclude<SessionTab, 'moments'>;

export function feedHref(
  tab: SessionTab,
  sub: FeedSub,
  params: { id?: string; index?: string; wine?: string; user?: string } = {},
): Href {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
  const pathname: string = `/(tabs)/${feedTab(tab)}/${sub}`;
  return { pathname, params: clean } as Href;
}

// The post list a detail/edit belongs to, for the "the post is gone, back to
// the list" exits: the network feed, your own profile (the You tab's root), or
// someone's profile pushed on this stack.
export function feedListHref(tab: SessionTab, userId: number | null, meId: number | null): Href {
  const t = feedTab(tab);
  if (userId == null) return tabHomeHref(t);
  if (t === 'you' && userId === meId) return tabHomeHref('you');
  const pathname: string = `/(tabs)/${t}/u/[id]`;
  return { pathname, params: { id: String(userId) } } as Href;
}

// The feed sub-tree has no Moments mount; a stray caller there lands on Feed.
function feedTab(tab: SessionTab): FeedTab {
  return tab === 'you' ? 'you' : 'feed';
}
