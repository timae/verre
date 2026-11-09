// Mirror route: the SAME screen as /(tabs)/feed/impression/[id], mounted under the
// YOU stack so posts and profiles opened from a profile keep back-nav on You.
// Pushes inside it are stack-relative (lib/sessionStack.ts feedHref).
export { default } from '@/app/(tabs)/feed/impression/[id]';
