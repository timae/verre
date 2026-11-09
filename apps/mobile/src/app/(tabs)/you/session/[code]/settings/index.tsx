// Mirror route (proposal 09 §B): the SAME session screen, mounted under the
// YOU stack so entering a moment from a post on a profile keeps back-nav on
// the profile. The Moments tab mounts it at /(tabs)/moments/session/[code]/settings;
// forward nav inside the sub-tree is stack-relative via
// useSessionTab()/sessionHref() (lib/sessionStack.ts).
export { default } from '@/app/(tabs)/moments/session/[code]/settings/index';
