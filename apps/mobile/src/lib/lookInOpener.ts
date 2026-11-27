// Where a look-in opened by LINK goes (Moment Visibility step-2 plan § 4.3),
// decided from the navigation container's root state. Pure, unit-tested from
// the repo root (scripts/tests/look-in-units.ts § 5); the hook that applies
// it is lib/usePendingLookIn.ts.
//
// - A fullscreen photo viewer open: it is CLOSED first (ruled 2026-11-24: a
//   photo holds nothing to lose), then the hook decides again.
// - It WAITS while something covers the tabs: a focused route outside
//   `(tabs)` (the root About / Attributions: a push would land in a tab stack
//   under them).
// - A post edit no longer makes it wait (ruled 2026-11-24, "like Check In"):
//   every edit is an ordinary push now, so the look-in opens ON TOP of it and
//   Back returns to the edit, its changes untouched.
// - Otherwise it pushes on the FOCUSED stack (no tab switch, nothing popped,
//   nothing presented on an outer stack while a post is open): the focused
//   tab, plus the opened post's id when its `[id]` is the tab stack's focused
//   route.
// - With Soon focused (a standalone screen, no stack) it switches to Moments
//   first; the hook re-decides once that state has committed.
export type NavRoute = { name: string; params?: object; state?: NavState };
export type NavState = { index?: number; routes: readonly NavRoute[] };
export type OpenerTab = 'feed' | 'moments' | 'you';
export type OpenerDecision =
  | { kind: 'wait' }
  | { kind: 'close-viewer' }
  | { kind: 'switch-to-moments' }
  | { kind: 'push'; mount: { tab: OpenerTab; post?: string } };

const focused = (s: NavState | undefined): NavRoute | undefined => (s && s.routes.length ? s.routes[s.index ?? s.routes.length - 1] : undefined);

export function openerDecision(root: NavState | undefined, viewerOpen: boolean): OpenerDecision {
  if (viewerOpen) return { kind: 'close-viewer' };
  // expo-router's container root is its internal stack (`__root`, the slot
  // that renders app/_layout.tsx); the app's own root Stack is inside it.
  let top = focused(root);
  if (top?.name === '__root') top = focused(top.state);
  if (!top || top.name !== '(tabs)') return { kind: 'wait' };
  const tabRoute = focused(top.state);
  if (!tabRoute) return { kind: 'wait' };
  if (tabRoute.name === 'soon') return { kind: 'switch-to-moments' };
  if (tabRoute.name !== 'feed' && tabRoute.name !== 'moments' && tabRoute.name !== 'you') return { kind: 'wait' };
  const tab = tabRoute.name;
  const onTop = focused(tabRoute.state);
  if (onTop?.name === '[id]') {
    const id = (onTop.params as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' || typeof id === 'number') return { kind: 'push', mount: { tab, post: String(id) } };
    return { kind: 'wait' };
  }
  return { kind: 'push', mount: { tab } };
}

// The tabs navigator's state key (the JUMP_TO target of the Soon case).
export function tabsStateKey(root: NavState | undefined): string | undefined {
  let top = focused(root);
  if (top?.name === '__root') top = focused(top.state);
  return top?.name === '(tabs)' ? (top.state as { key?: string } | undefined)?.key : undefined;
}
