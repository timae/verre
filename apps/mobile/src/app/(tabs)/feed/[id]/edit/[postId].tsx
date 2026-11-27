// Mirror route: the post EDIT screen (feed/edit/[id].tsx) on an opened post's
// own stack, for an edit started inside the post (the detail's ⋯, a card, a
// profile list there). An ordinary push with swipe-back like the outer edit
// (since 2026-11-24), on the post's stack: nothing may be presented over an
// open post. The edited post is `postId` (`id` is the opened post).
export { default } from '@/app/(tabs)/feed/edit/[id]';
