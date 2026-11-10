// Mirror route: the app-root legal screen (app/attributions.tsx) on an opened post's own
// stack. A push to the root /attributions from inside a post lands behind the
// presented post (lib/sessionStack.ts legalHref); the root route stays the
// canonical, signed-out-reachable one.
export { default } from '@/app/attributions';
