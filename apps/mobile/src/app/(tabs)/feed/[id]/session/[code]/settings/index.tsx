// Mirror route: the SAME session screen, mounted on an OPENED POST's own
// stack (feed/[id]/_layout.tsx), so a moment entered from the post is a card
// push and back returns to the post. Forward nav inside the sub-tree is
// mount-relative via useSessionTab()/sessionHref() (lib/sessionStack.ts).
export { default } from '@/app/(tabs)/moments/session/[code]/settings/index';
