// Mirror route (Moment Visibility step-2 plan § 4.1): the SAME look-in, mounted
// on this stack so opening a moment from outside keeps back-nav here. Forward
// pushes inside it are mount-relative (lib/sessionStack.ts lookHref).
export { default } from '@/app/(tabs)/moments/look/[momentId]/index';
