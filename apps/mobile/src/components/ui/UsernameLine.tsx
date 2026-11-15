import { VText } from './VText';
import type { FontSurfaceName } from '@/lib/layout';

// A person's `@username` (usernames): regular weight, secondary ink, on its
// OWN line under the name, cut at the end with "…". Renders nothing for
// someone who has not chosen one (`suffix` alone still shows). Where it shows
// is ruled (2026-11-14): finding or confirming someone (search, scan, share,
// invite, the profile header, Blocked / Muted, Settings); never in the feed,
// on People lists or inside a moment.
export function UsernameLine({
  username, suffix, variant = 'small', color = 'inkSoft', surface,
}: {
  username: string | null | undefined;
  // After the name, e.g. "Follows you" → "@lena · Follows you".
  suffix?: string | null;
  variant?: 'small' | 'caption' | 'body';
  color?: string;
  surface?: FontSurfaceName;
}) {
  const text = [username ? `@${username}` : null, suffix || null].filter(Boolean).join(' · ');
  if (!text) return null;
  return <VText variant={variant} color={color} surface={surface} numberOfLines={1} ellipsizeMode="tail">{text}</VText>;
}
