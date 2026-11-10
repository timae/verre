import { createContext, useContext, useRef } from 'react';
import { useSegments } from 'expo-router';
import type { Href } from 'expo-router';

// The session sub-tree is mounted under THREE tab stacks (proposal 09 §B):
// Moments owns /(tabs)/moments/session/[code]; Feed and You mirror it at
// /(tabs)/feed/session/[code] and /(tabs)/you/session/[code] (thin re-export
// route files), so entering a moment from a post stays ON that stack and back
// returns to the post. (You mounts it because a profile lists posts too.)
// An OPENED POST has its own nested stack on top of that (/(tabs)/<tab>/[id]/…,
// the transparent modal's inner Stack): the moment, profile or post opened
// from inside it pushes there as a real card. Every forward push INSIDE these
// sub-trees must therefore be mount-relative — a hardcoded /(tabs)/moments/...
// would silently hop a feed-stack visitor over to the Moments tab, and a plain
// tab path would push ABOVE the opened post (the page-sheet stacking). Resolve
// the mount with useSessionTab() and build hrefs with sessionHref() /
// feedHref() / feedListHref().

export type SessionTab = 'moments' | 'feed' | 'you';

// Where a screen is mounted: its tab stack and, inside an opened post's own
// stack, that post's feed-item id (the `[id]` the nested stack hangs off).
export type SessionMount = { readonly tab: SessionTab; readonly post?: string };

// Stable values for the tab stacks' providers (a fresh object per render would
// re-render every consumer).
export const TAB_MOUNTS: Readonly<Record<SessionTab, SessionMount>> = {
  moments: { tab: 'moments' },
  feed: { tab: 'feed' },
  you: { tab: 'you' },
};

// The mount, from where the CALLER IS MOUNTED: each tab's stack layout
// provides it (SessionTabProvider in moments/feed/you `_layout.tsx`), and the
// opened post's own layout (`feed/[id]/_layout.tsx`, mirrored under You)
// re-provides it with the post id, so a screen or list resolves its own stack
// even when it first renders in a background tab — e.g. a profile whose posts
// mount once the header query resolves after you switched tabs (Codex,
// 2026-11-09).
//
// Fallback (no provider — called somewhere unexpected): segments look like
// ['(tabs)', 'feed', 'session', '[code]', ...], the tab route group is the
// second; default 'moments' (the original home of the sub-tree). That is
// global "current route" state, not "the stack this instance is mounted in",
// so it is PINNED at first render: an EFFECT firing on a blurred background
// instance would otherwise resolve the FOREGROUND tab and bounce on the
// wrong stack. A mounted instance's owning stack can never change.
const SessionTabContext = createContext<SessionMount | null>(null);
export const SessionTabProvider = SessionTabContext.Provider;

export function useSessionTab(): SessionMount {
  const fromLayout = useContext(SessionTabContext);
  const segments = useSegments();
  const pinned = useRef<SessionMount | null>(null);
  if (pinned.current === null) {
    pinned.current = fromLayout ?? TAB_MOUNTS[segments[1] === 'feed' ? 'feed' : segments[1] === 'you' ? 'you' : 'moments'];
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

// The casts live here and nowhere else: every variant is a REAL route (the
// mirror files make them so), but a computed pathname can't satisfy the
// typed-routes literal union.
export function sessionHref(
  mount: SessionMount,
  sub: SessionSub,
  params: { code: string; wineId?: string },
): Href {
  const tail = `session/[code]${sub ? `/${sub}` : ''}`;
  if (mount.post != null) {
    return { pathname: `/(tabs)/${feedTab(mount.tab)}/[id]/${tail}`, params: { id: mount.post, ...params } } as Href;
  }
  return { pathname: `/(tabs)/${mount.tab}/${tail}`, params } as Href;
}

// The TAB ROOT (Moments / Feed / You home). Deliberately not "the mount's
// home": inside an opened post, going home closes the post (a replace from in
// there would leave the post's modal underneath).
export function tabHomeHref(tab: SessionTab): Href {
  return `/(tabs)/${tab}` as Href;
}

// ── Posts + profiles (the feed sub-tree) ─────────────────────────────────────
// The post detail, its edit screens and the profile screen are mounted under
// Feed AND You (You's are one-line re-export mirrors), so their pushes are
// mount-relative too. `user` on a post route names the list it came from: the
// detail/edit read and write THAT list's cache (lib/api/feed.ts feedKey) —
// absent = the network feed.
//
// Destinations per suffix (NOT a blanket prefix):
//   • 'post' / 'profile' — inside an opened post they push onto ITS stack as
//     siblings (`[id]/post/[postId]` = the detail in card mode,
//     `[id]/u/[personId]`), so no route tree nests inside itself;
//   • 'edit' / 'edit/details' — from a tab stack, the OUTER edit screens
//     (fullScreenModal there); from inside a post, the same screens on the
//     POST's stack (`[id]/edit/[postId]`, sliding up like the modal). Nothing
//     may be presented on the outer stack while a post is open: a native
//     modal over the contained post hung the app (device pass 2026-11-10).
//     So the "post is gone" exits there are plain pops on the post's stack.
type FeedSub = 'post' | 'edit' | 'edit/details' | 'profile';
type FeedTab = Exclude<SessionTab, 'moments'>;

export function feedHref(
  mount: SessionMount,
  sub: FeedSub,
  params: { id?: string; index?: string; wine?: string; user?: string } = {},
): Href {
  const t = feedTab(mount.tab);
  const clean = (p: Record<string, string | undefined>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v != null));
  const inPost = mount.post != null;
  let pathname: string;
  let out: Record<string, string | undefined>;
  switch (sub) {
    case 'post':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/post/[postId]`;
        out = { id: mount.post, postId: params.id, index: params.index, user: params.user };
      } else {
        pathname = `/(tabs)/${t}/[id]`;
        out = { id: params.id, index: params.index, user: params.user };
      }
      break;
    case 'profile':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/u/[personId]`;
        out = { id: mount.post, personId: params.id };
      } else {
        pathname = `/(tabs)/${t}/u/[id]`;
        out = { id: params.id };
      }
      break;
    case 'edit':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/edit/[postId]`;
        out = { id: mount.post, postId: params.id, wine: params.wine, user: params.user };
      } else {
        pathname = `/(tabs)/${t}/edit/[id]`;
        out = { id: params.id, wine: params.wine, user: params.user };
      }
      break;
    case 'edit/details':
      pathname = inPost ? `/(tabs)/${t}/[id]/edit/details` : `/(tabs)/${t}/edit/details`;
      out = { id: mount.post, user: params.user };
      break;
  }
  return { pathname, params: clean(out) } as Href;
}

// Settings (the interim You settings). Inside an opened post it is mirrored
// onto the post's stack: pushing /you/settings there would present on the
// outer You stack, over the post (see 'edit' above).
export function settingsHref(mount: SessionMount): Href {
  if (mount.post != null) return { pathname: `/(tabs)/${feedTab(mount.tab)}/[id]/settings`, params: { id: mount.post } } as Href;
  return '/you/settings' as Href;
}

// The legal screens (About hub, Attributions). They live at the app ROOT so
// they render signed out (a licence obligation, root _layout.tsx); inside an
// opened post they are ALSO mirrored onto the post's stack, because a root
// push there lands behind the presented post (device pass 2026-11-10: back
// came out on You). The root routes stay the canonical ones.
export function legalHref(mount: SessionMount, screen: 'about' | 'attributions'): Href {
  if (mount.post != null) return { pathname: `/(tabs)/${feedTab(mount.tab)}/[id]/${screen}`, params: { id: mount.post } } as Href;
  return `/${screen}` as Href;
}

// The post list a detail/edit belongs to, for the "the post is gone, back to
// the list" exits: the network feed, your own profile (the You tab's root), or
// someone's profile pushed on this stack. Inside an opened post the list is
// always a profile pushed on THAT post's stack (`dismissTo` it pops whatever
// sits above it there).
export function feedListHref(mount: SessionMount, userId: number | null, meId: number | null): Href {
  const t = feedTab(mount.tab);
  if (mount.post != null && userId != null) {
    return { pathname: `/(tabs)/${t}/[id]/u/[personId]`, params: { id: mount.post, personId: String(userId) } } as Href;
  }
  if (userId == null) return tabHomeHref(t);
  if (t === 'you' && userId === meId) return tabHomeHref('you');
  return { pathname: `/(tabs)/${t}/u/[id]`, params: { id: String(userId) } } as Href;
}

// The post is GONE and it is the one an opened post's stack hangs off (your
// own post A → your profile → A again as a card, or its edit, then deleted):
// leaving only the card would uncover the modal's pinned copy of the deleted
// post (Codex r1). Pop the opened post's route (`[id]` = postId) and
// everything above it from the tab stack that holds it, landing on whatever
// opened it. Walks up from the caller (a screen on the post's stack, or the
// outer edit screen). False when no such route is mounted.
type NavLike = {
  getState(): { key: string; routes: readonly { name: string; params?: object }[] } | undefined;
  getParent(): NavLike | undefined;
  dispatch(action: { type: 'POP'; payload: { count: number }; target: string; source: undefined }): void;
};
export function closeOpenedPost(navigation: NavLike, postId: string): boolean {
  for (let nav: NavLike | undefined = navigation; nav; nav = nav.getParent()) {
    const st = nav.getState();
    if (!st) continue;
    for (let i = st.routes.length - 1; i >= 0; i--) {
      const r = st.routes[i];
      if (r.name === '[id]' && (r.params as { id?: string } | undefined)?.id === postId) {
        // `source: undefined` is load-bearing: an ancestor's navigation object
        // stamps ITS route (the post) as the source, and a sourced POP counts
        // back from that route instead of from the top, so with anything
        // pushed above the post meanwhile it would remove the screens BELOW it
        // (Codex r2). Unsourced, it pops from the top: the post and all above.
        nav.dispatch({ type: 'POP', payload: { count: st.routes.length - i }, target: st.key, source: undefined });
        return true;
      }
    }
  }
  return false;
}

// The feed sub-tree has no Moments mount; a stray caller there lands on Feed.
function feedTab(tab: SessionTab): FeedTab {
  return tab === 'you' ? 'you' : 'feed';
}
