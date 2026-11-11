import type { CheckinVisibility, ProfileVisibility, VisibilitySettings } from './api/settings';

// The Privacy page's post-audience rules (You profile step 4), pure so they can
// be checked against the server's `canViewPosts` (lib/profileVisibility.ts).

const BREADTH: Record<ProfileVisibility | CheckinVisibility, number> = {
  'public-internet': 0, 'public-users': 1, 'public-followers': 2, 'public-mutual': 3, 'only-me': 4,
};
export const broader = (c: CheckinVisibility, account: ProfileVisibility) => BREADTH[c] < BREADTH[account];
export const sameTier = (c: CheckinVisibility, account: ProfileVisibility) => c !== 'only-me' && BREADTH[c] === BREADTH[account];
// The extended circle (stored `fofEnabled`) only applies to the two strict
// tiers; a stored one rides along hidden under the others.
export const extendedApplies = (v: ProfileVisibility) => v === 'public-followers' || v === 'public-mutual';
export const extendedOn = (s: VisibilitySettings) => extendedApplies(s.visibility) && s.fofEnabled;

// 🔒 No contradiction between the switch and the choice (ruled 2026-11-11),
// and NEVER a wider audience by it. A posts choice whose audience EQUALS the
// account's IS "Same as Account" (null): without the extended circle, any
// choice as wide as the account or wider (limited to it anyway); WITH the
// circle on, only Verre Users (an explicit tier never includes the circle, so
// e.g. Followers under Friends + circle keeps out circle members who don't
// follow you: narrower, not the same). That exact collapse runs on every save
// and on display. On an ACCOUNT change (tier or circle) a choice still wider
// than the account while the circle is on CLAMPS to the account's tier
// ("without friends of friends"): it can only narrow. Pinned against the
// server predicate by .local/you-profile/check-post-audience.mts. (The server
// applies the same rule on write once its change lands:
// .local/you-profile/fof-tier-build-prompt.md.)
export const sameAudience = (c: CheckinVisibility, s: VisibilitySettings) =>
  c !== 'only-me' && (extendedOn(s) ? c === 'public-users' : BREADTH[c] <= BREADTH[s.visibility]);
export function canonical(s: VisibilitySettings, accountChanged = false): VisibilitySettings {
  const c = s.checkinVisibility;
  if (!c) return s;
  if (sameAudience(c, s)) return { ...s, checkinVisibility: null };
  if (accountChanged && extendedOn(s) && broader(c, s.visibility)) return { ...s, checkinVisibility: s.visibility as CheckinVisibility };
  return s;
}
