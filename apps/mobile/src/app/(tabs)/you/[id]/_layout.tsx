// Mirror route: the opened post's own stack (feed/[id]/_layout.tsx), mounted
// under the YOU stack. The layout takes its tab from the enclosing provider,
// so the same code serves both. unstable_settings must be re-exported too.
export { default, unstable_settings } from '@/app/(tabs)/feed/[id]/_layout';
