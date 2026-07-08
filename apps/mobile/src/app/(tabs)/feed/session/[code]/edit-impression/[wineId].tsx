// Mirror route (proposal 09 §B): the SAME session screen, mounted under the
// FEED stack so entering a moment from a feed post keeps back-nav on the feed.
// The Moments tab mounts it at /(tabs)/moments/session/[code]/edit-impression/[wineId]; forward nav
// inside the sub-tree is stack-relative via useSessionTab()/sessionHref()
// (lib/sessionStack.ts), so the shared component pushes its siblings on
// whichever stack it's mounted on.
export { default } from '@/app/(tabs)/moments/session/[code]/edit-impression/[wineId]';
