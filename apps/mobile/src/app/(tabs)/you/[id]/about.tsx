// Mirror route: the app-root legal screen (app/about.tsx) on an opened post's own
// stack. A push to the root /about from inside a post lands behind the
// presented post (lib/sessionStack.ts legalHref); the root route stays the
// canonical, signed-out-reachable one.
export { default } from '@/app/about';
