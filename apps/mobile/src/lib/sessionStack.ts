import { useRef } from 'react';
import { useSegments } from 'expo-router';
import type { Href } from 'expo-router';

// The session sub-tree is mounted under BOTH tab stacks (proposal 09 §B):
// Moments owns /(tabs)/moments/session/[code] and Feed mirrors it at
// /(tabs)/feed/session/[code] (thin re-export route files), so entering a
// moment from a feed post stays ON the feed stack and back returns to the
// post. Every forward push INSIDE the sub-tree must therefore be
// stack-relative — a hardcoded /(tabs)/moments/... would silently hop a
// feed-stack visitor over to the Moments tab. Resolve the owning tab with
// useSessionTab() and build hrefs with sessionHref().

export type SessionTab = 'moments' | 'feed';

// Segments look like ['(tabs)', 'feed', 'session', '[code]', ...] — the tab
// route group is the second segment. Defaults to 'moments' (the original
// home of the sub-tree) if called somewhere unexpected.
//
// PINNED at first render: useSegments() is global "current route" state, not
// "the stack this instance is mounted in" — with the sub-tree mounted under
// both tabs at once, an EFFECT firing on the blurred background instance
// (e.g. the shared session-state cache going fatal) would otherwise resolve
// the FOREGROUND tab and bounce on the wrong stack. A mounted instance's
// owning stack can never change, so the first render's answer is the truth.
export function useSessionTab(): SessionTab {
  const segments = useSegments();
  const pinned = useRef<SessionTab | null>(null);
  if (pinned.current === null) pinned.current = segments[1] === 'feed' ? 'feed' : 'moments';
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
