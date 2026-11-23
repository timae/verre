// Where a look-in opened by LINK goes (Moment Visibility step-2 plan § 4.3),
// decided from the navigation container's root state. Pure, unit-tested from
// the repo root (scripts/tests/look-in-units.ts § 5); the hook that applies
// it is lib/usePendingLookIn.ts.
//
// - It WAITS while someone is mid-edit or something covers the tabs: a post
//   edit anywhere in the route lists of the stacks on the focused chain (the
//   outer `edit/[id]` / `edit/details` full-screen modals on a tab stack, the
//   catalogue pages inside the latter included; an opened post's own
//   `edit/[postId]` / `edit/details`, whose catalogue pages are SIBLINGS on the
//   post's stack, Codex r3), the fullscreen photo viewer, or a focused route
//   outside `(tabs)` (the root About / Attributions: a push would land in a
//   tab stack under them).
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
  | { kind: 'switch-to-moments' }
  | { kind: 'push'; mount: { tab: OpenerTab; post?: string } };

const TAB_STACK_EDITS = new Set(['edit/[id]', 'edit/details']);
const POST_STACK_EDITS = new Set(['edit/[postId]', 'edit/details']);
const focused = (s: NavState | undefined): NavRoute | undefined => (s && s.routes.length ? s.routes[s.index ?? s.routes.length - 1] : undefined);

export function openerDecision(root: NavState | undefined, viewerOpen: boolean): OpenerDecision {
  if (viewerOpen) return { kind: 'wait' };
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
  const stack = tabRoute.state;
  if (stack?.routes.some((r) => TAB_STACK_EDITS.has(r.name))) return { kind: 'wait' };
  const onTop = focused(stack);
  if (onTop?.name === '[id]') {
    if (onTop.state?.routes.some((r) => POST_STACK_EDITS.has(r.name))) return { kind: 'wait' };
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
