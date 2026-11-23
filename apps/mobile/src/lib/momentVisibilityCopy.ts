// Moment Visibility's words (step-2 plan § 4.6, R9). Pure, unit-tested from the
// repo root (scripts/tests/look-in-compare-units.ts). The audience is the HOST's
// circle: the host reads "Your …", everyone else "Host's …".
export type Audience = 'members' | 'friends' | 'followers' | 'verre';
export type Perspective = 'host' | 'other';

export const AUDIENCE_ORDER: readonly Audience[] = ['members', 'friends', 'followers', 'verre'];

export function audienceLabel(a: Audience, who: Perspective): string {
  if (a === 'members') return 'Only People in It';
  if (a === 'verre') return 'Verre Users';
  const whose = who === 'host' ? 'Your' : 'Host’s';
  return a === 'friends' ? `${whose} Friends` : `${whose} Followers`;
}

// The guests' circle switch exists for Friends and Followers only.
export const guestCirclesApply = (a: Audience): boolean => a === 'friends' || a === 'followers';
export const guestCirclesTitle = (a: Audience): string => (a === 'followers' ? 'Include Followers of Guests' : 'Include Friends of Guests');

// The hub row's value, e.g. "Host’s Friends + friends of guests".
export function audienceSummary(a: Audience, includeGuestCircles: boolean, who: Perspective): string {
  const base = audienceLabel(a, who);
  if (!includeGuestCircles || !guestCirclesApply(a)) return base;
  return `${base} + ${a === 'followers' ? 'followers' : 'friends'} of guests`;
}

// A frozen moment (no signed-in host) can only be narrowed: a wider audience
// is off the list.
export const widerThan = (a: Audience, current: Audience): boolean => AUDIENCE_ORDER.indexOf(a) > AUDIENCE_ORDER.indexOf(current);
