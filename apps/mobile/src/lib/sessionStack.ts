import { createContext, createElement, useContext, useRef, type ReactNode } from 'react';
import { useSegments } from 'expo-router';
import type { Href } from 'expo-router';

// The session sub-tree is mounted under THREE tab stacks (proposal 09 §B):
// Moments owns /(tabs)/moments/session/[code]; Feed and You mirror it at
// /(tabs)/feed/session/[code] and /(tabs)/you/session/[code] (thin re-export
// route files), so entering a moment from a post stays ON that stack and back
// returns to the post. (You mounts it because a profile lists posts too.)
// Likewise Feed owns the post + profile sub-tree and You AND Moments mirror it.
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
// Fallback, for screens outside every tab stack (the root About /
// Attributions pages): `SessionTabRootProvider` around the root Stack provides
// the tab of the CURRENT route (segments look like ['(tabs)', 'feed',
// 'session', '[code]', ...], the tab route group is the second; default
// 'moments', the original home of the sub-tree). That is global "current
// route" state, not "the stack this instance is mounted in", so every mount is
// PINNED at first render: an EFFECT firing on a blurred background instance
// would otherwise resolve the FOREGROUND tab and bounce on the wrong stack. A
// mounted instance's owning stack can never change. useSessionTab() itself
// never subscribes to route state: it did (useSegments), and every caller in
// the app re-rendered on every navigation (2026-11-17); now a navigation
// re-renders the root provider alone, and its consumers only when the tab
// changes (every tab stack re-provides its own value).
const SessionTabContext = createContext<SessionMount | null>(null);
export const SessionTabProvider = SessionTabContext.Provider;

export function SessionTabRootProvider({ children }: { children: ReactNode }) {
  const segments = useSegments();
  const tab: SessionTab = segments[1] === 'feed' ? 'feed' : segments[1] === 'you' ? 'you' : 'moments';
  return createElement(SessionTabContext.Provider, { value: TAB_MOUNTS[tab] }, children);
}

export function useSessionTab(): SessionMount {
  const fromLayout = useContext(SessionTabContext);
  const pinned = useRef<SessionMount | null>(null);
  if (pinned.current === null) pinned.current = fromLayout ?? TAB_MOUNTS.moments;
  return pinned.current;
}

type SessionSub =
  | ''
  | 'add'
  | 'settings'
  | 'settings/details'
  | 'settings/reveal'
  | 'settings/visibility'
  | 'settings/my-privacy'
  // (No 'impression/[wineId]' since build 2: the impression is a layer inside
  // the line-up, ADR-0011.)
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
    return { pathname: `/(tabs)/${mount.tab}/[id]/${tail}`, params: { id: mount.post, ...params } } as Href;
  }
  return { pathname: `/(tabs)/${mount.tab}/${tail}`, params } as Href;
}

// The LOOK-IN (Moment Visibility step-2 plan § 4.1): a moment seen from
// outside, by its public id, never its code. Owned by Moments
// (`moments/look/[momentId]/…`), mirrored on Feed, You and every opened post's
// stack, like the session sub-tree. `via: 'link'` + `h` (a handle of
// lib/lookInLinks.ts, never the token) = opened by a look-in link.
export type LookSub = '' | 'bottle/[key]';
export function lookHref(mount: SessionMount, sub: LookSub, params: { momentId: string; key?: string; via?: 'link'; h?: string }): Href {
  const tail = `look/[momentId]${sub ? `/${sub}` : ''}`;
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)) as Record<string, string>;
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/${tail}`, params: { id: mount.post, ...clean } } as Href;
  return { pathname: `/(tabs)/${mount.tab}/${tail}`, params: clean } as Href;
}

// The TAB ROOT (Moments / Feed / You home). Deliberately not "the mount's
// home": inside an opened post, going home closes the post (a replace from in
// there would leave the post's modal underneath).
export function tabHomeHref(tab: SessionTab): Href {
  return `/(tabs)/${tab}` as Href;
}

// ── Posts + profiles (the feed sub-tree) ─────────────────────────────────────
// The post detail, its edit screens and the profile screen are mounted under
// Feed, You AND Moments (You's and Moments' are one-line re-export mirrors;
// Moments since 2026-11-15, for a person opened inside a moment), so their
// pushes are mount-relative too. `user` on a post route names the list it came from: the
// detail/edit read and write THAT list's cache (lib/api/feed.ts feedKey) —
// absent = the network feed.
//
// Destinations per suffix (NOT a blanket prefix):
//   • 'post' / 'profile' / 'people' — inside an opened post they push onto
//     ITS stack as siblings (`[id]/post/[postId]` = the detail in card mode,
//     `[id]/u/[personId]`, `[id]/people/[personId]`), so no route tree nests
//     inside itself;
//   • 'edit' / 'edit/details' — from a tab stack, the OUTER edit screens
//     (plain pushes with swipe-back since 2026-11-24); from inside a post,
//     the same screens on the POST's stack (`[id]/edit/[postId]`). Nothing
//     may be presented on the outer stack while a post is open: a native
//     modal over the contained post hung the app (device pass 2026-11-10).
//     So the "post is gone" exits there are plain pops on the post's stack.
//   • 'impressions' / 'moments' / 'cravings' — someone's (or your) tile lists
//     (lists plan): like 'people', their own route on a post's stack.
//   • 'palate' (someone's or yours) / 'status' (yours, no id) — the status
//     line's placeholder pages (2026-11-14): likewise.
//   `source: 'item'` (post / edit) = opened from a tile list: those screens
//   read ONLY that post's item query (lib/useFeedPost.ts), and the edit's
//   "post is gone" exit is a plain pop back to the list (closePost).
type FeedSub = 'post' | 'edit' | 'edit/details' | 'profile' | 'people' | 'palate' | 'status' | ListSub;
type ListSub = 'impressions' | 'moments' | 'cravings';

export function feedHref(
  mount: SessionMount,
  sub: FeedSub,
  params: { id?: string; index?: string; wine?: string; user?: string; tab?: string; known?: string; source?: 'item'; edit?: string } = {},
): Href {
  const t = mount.tab;
  const clean = (p: Record<string, string | undefined>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v != null));
  const inPost = mount.post != null;
  let pathname: string;
  let out: Record<string, string | undefined>;
  switch (sub) {
    case 'post':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/post/[postId]`;
        out = { id: mount.post, postId: params.id, index: params.index, user: params.user, source: params.source };
      } else {
        pathname = `/(tabs)/${t}/[id]`;
        out = { id: params.id, index: params.index, user: params.user, source: params.source };
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
    // Someone's People (Friends / Followers / Following): `tab` + `known`
    // ('1' = "Only people you know" on) seed the screen. Like 'profile', on an
    // opened post's stack it is its own route (`id` is the post there).
    case 'people':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/people/[personId]`;
        out = { id: mount.post, personId: params.id, tab: params.tab, known: params.known };
      } else {
        pathname = `/(tabs)/${t}/people/[id]`;
        out = { id: params.id, tab: params.tab, known: params.known };
      }
      break;
    case 'edit':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/edit/[postId]`;
        out = { id: mount.post, postId: params.id, wine: params.wine, user: params.user, source: params.source };
      } else {
        pathname = `/(tabs)/${t}/edit/[id]`;
        out = { id: params.id, wine: params.wine, user: params.user, source: params.source };
      }
      break;
    case 'edit/details':
      pathname = inPost ? `/(tabs)/${t}/[id]/edit/details` : `/(tabs)/${t}/edit/details`;
      // `edit`: the edit screen's key into the details store (lib/checkinEdit.ts).
      out = { id: mount.post, user: params.user, edit: params.edit };
      break;
    case 'status':
      pathname = inPost ? `/(tabs)/${t}/[id]/status` : `/(tabs)/${t}/status`;
      out = { id: mount.post };
      break;
    case 'palate':
    case 'impressions':
    case 'moments':
    case 'cravings':
      if (inPost) {
        pathname = `/(tabs)/${t}/[id]/${sub}/[personId]`;
        out = { id: mount.post, personId: params.id };
      } else {
        pathname = `/(tabs)/${t}/${sub}/[id]`;
        out = { id: params.id };
      }
      break;
  }
  return { pathname, params: clean(out) } as Href;
}

// The create flows (lists plan D8), mount-relative: the Feed's "Check In"
// pill and your Impressions' "+ Check In" run the SAME two stages on their own
// stack (`<tab>/check-in`, `<tab>/check-in/rate`), and moment create runs from
// Moments home or your Moments' "+ New" (`<tab>/moments/create`), landing in
// the new moment on that stack. Never inside an opened post (the pills don't
// show there: a reading context).
export function checkinHref(mount: SessionMount, stage?: 'rate'): Href {
  return `/(tabs)/${mount.tab}/check-in${stage ? '/rate' : ''}` as Href;
}
export function momentCreateHref(mount: SessionMount): Href {
  return (mount.tab === 'moments' ? '/(tabs)/moments/create' : `/(tabs)/${mount.tab}/moments/create`) as Href;
}
// Create Moment's Privacy page (Moment Defaults, plan § 3): a SIBLING of each
// create mount (`<tab>/moments/create-privacy`), its state in the per-screen
// store `lib/createPrivacy.ts` under `key`, so swipe-back keeps the choices.
export function momentCreatePrivacyHref(mount: SessionMount, key: string): Href {
  return { pathname: mount.tab === 'moments' ? '/(tabs)/moments/create-privacy' : `/(tabs)/${mount.tab}/moments/create-privacy`, params: { key } } as Href;
}

// Settings: the hub (no page) and its pages. Inside an opened post every one
// is mirrored onto the post's stack: pushing /you/settings/… there would
// present on the outer You stack, over the post (see 'edit' above). No page
// may be named `details` / `reveal` / `visibility`: the tabs layout hides the
// pill on those suffixes for the moment settings.
export type SettingsPage = 'privacy' | 'defaults' | 'blocked' | 'muted' | 'account' | 'change-email' | 'change-password' | 'appearance';
export function settingsHref(mount: SessionMount, page?: SettingsPage): Href {
  const tail = page ? `settings/${page}` : 'settings';
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/${tail}`, params: { id: mount.post } } as Href;
  return `/you/${tail}` as Href;
}

// The "Add Wine to Catalogue" pages (ruled 2026-11-22: real pages, so the
// bar's back and the edge swipe go back alike). They live beside their host on
// the host's OWN stack: an opened post's stack (`[id]/catalog/…`), or the tab
// stack (`catalog/…`), except the check-in edit's details on a tab stack,
// whose pages live INSIDE its own boundary (`edit/details/catalog/…`; built
// while those details were a modal, edit/details/_layout.tsx).
export type CatalogPage = 'search' | 'producer' | 'wines' | 'new';
export function catalogHref(mount: SessionMount, inDetails: boolean, page: CatalogPage, key: string): Href {
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/catalog/${page}`, params: { id: mount.post, key } } as Href;
  if (inDetails) return { pathname: `/(tabs)/${mount.tab}/edit/details/catalog/${page}`, params: { key } } as Href;
  return { pathname: `/(tabs)/${mount.tab}/catalog/${page}`, params: { key } } as Href;
}

// Where a pick goes while ADDING (ruled 2026-11-22: the details are a screen
// of their own, pushed on top of the search or of the page the pick was made
// on): Add Impression's details beside its search (`session/[code]/add-wine`,
// on the moment's stack, an opened post's included), Check In's beside its own
// (`check-in/wine`).
export type FlowDest = { kind: 'impression'; code: string } | { kind: 'checkin' };
export function pickedHref(mount: SessionMount, dest: FlowDest, key: string): Href {
  if (dest.kind === 'checkin') return { pathname: `/(tabs)/${mount.tab}/check-in/wine`, params: { key } } as Href;
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/session/[code]/add-wine`, params: { id: mount.post, code: dest.code, key } } as Href;
  return { pathname: `/(tabs)/${mount.tab}/session/[code]/add-wine`, params: { code: dest.code, key } } as Href;
}

// Edit Profile (your own profile's ⋯ → Edit Profile, ruling D1): like
// Settings, mirrored onto an opened post's stack when called from inside it.
export function profileEditHref(mount: SessionMount): Href {
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/edit-profile`, params: { id: mount.post } } as Href;
  return '/you/edit-profile' as Href;
}

// The legal screens (About hub, Attributions). They live at the app ROOT so
// they render signed out (a licence obligation, root _layout.tsx); inside an
// opened post they are ALSO mirrored onto the post's stack, because a root
// push there lands behind the presented post (device pass 2026-11-10: back
// came out on You). The root routes stay the canonical ones.
export function legalHref(mount: SessionMount, screen: 'about' | 'attributions'): Href {
  if (mount.post != null) return { pathname: `/(tabs)/${mount.tab}/[id]/${screen}`, params: { id: mount.post } } as Href;
  // From the You stack (Settings): its own mirrors, so the Dev Gallery is a
  // push on the same stack. The root routes (signed out, the auth screens:
  // the root fallback mount is never 'you') stay the canonical ones.
  if (mount.tab === 'you') return `/you/${screen}` as Href;
  return `/${screen}` as Href;
}

// The post list a detail/edit belongs to, for the "the post is gone, back to
// the list" exits: the network feed, your own profile (the You tab's root), or
// someone's profile pushed on this stack. Inside an opened post the list is
// always a profile pushed on THAT post's stack (`dismissTo` it pops whatever
// sits above it there).
export function feedListHref(mount: SessionMount, userId: string | null, meId: string | null): Href {
  const t = mount.tab;
  if (mount.post != null && userId != null) {
    return { pathname: `/(tabs)/${t}/[id]/u/[personId]`, params: { id: mount.post, personId: userId } } as Href;
  }
  if (userId == null) return tabHomeHref(t);
  if (t === 'you' && userId === meId) return tabHomeHref('you');
  return { pathname: `/(tabs)/${t}/u/[id]`, params: { id: userId } } as Href;
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
// The "post is gone" exit of a post opened from a tile list (`source: 'item'`):
// a plain pop back to the LIST (feedListHref would land one screen too far,
// on the profile). Pops the post's route (the modal `[id]` or a card
// `post/[postId]`) and everything above it, nearest first. False when none.
export function closePost(navigation: NavLike, postId: string): boolean {
  for (let nav: NavLike | undefined = navigation; nav; nav = nav.getParent()) {
    const st = nav.getState();
    if (!st) continue;
    for (let i = st.routes.length - 1; i >= 0; i--) {
      const r = st.routes[i];
      const p = r.params as { id?: string; postId?: string } | undefined;
      if ((r.name === 'post/[postId]' && p?.postId === postId) || (r.name === '[id]' && p?.id === postId)) {
        nav.dispatch({ type: 'POP', payload: { count: st.routes.length - i }, target: st.key, source: undefined });
        return true;
      }
    }
  }
  return false;
}

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

