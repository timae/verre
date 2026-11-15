// Mirror route: the opened post's own stack (feed/[id]/_layout.tsx), mounted
// under the MOMENTS stack (a post opened from a profile reached inside a
// moment). The layout takes its tab from the enclosing provider; unstable_settings
// must be re-exported too.
export { default, unstable_settings } from '@/app/(tabs)/feed/[id]/_layout';
