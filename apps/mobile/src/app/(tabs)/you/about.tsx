// Mirror route: the app-root legal screen (app/about.tsx) on the You stack,
// opened from Settings (lib/sessionStack.ts legalHref), so a push from it (the
// Dev Gallery) is an ordinary push and Back returns to About. The root route
// stays the canonical, signed-out-reachable one.
export { default } from '@/app/about';
