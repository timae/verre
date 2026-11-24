// Moment Visibility's words (step-2 plan § 4.6, R9). Pure, unit-tested from the
// repo root (scripts/tests/look-in-compare-units.ts). The audience is the HOST's
// circle: the host reads "Your …", everyone else "Host's …".
export type Audience = 'members' | 'friends' | 'followers' | 'verre';
export type Perspective = 'host' | 'other';

// Narrowest to widest: the scale `widerThan` reads (the frozen rule).
export const AUDIENCE_ORDER: readonly Audience[] = ['members', 'friends', 'followers', 'verre'];
// The Visible To sheet: widest first, like You → Settings → Privacy (Everyone /
// Verre Users / Followers / Friends; Only Me last), ruled 2026-11-24.
export const AUDIENCE_MENU: readonly Audience[] = ['verre', 'followers', 'friends', 'members'];

export function audienceLabel(a: Audience, who: Perspective): string {
  if (a === 'members') return 'Only People in It';
  if (a === 'verre') return 'Verre Users';
  const whose = who === 'host' ? 'Your' : 'Host’s';
  return a === 'friends' ? `${whose} Friends` : `${whose} Followers`;
}

// The circles of the people in the moment: a switch for Friends and Followers
// only. "People in It", like the audience option (ruled 2026-11-24, not "guests").
export const guestCirclesApply = (a: Audience): boolean => a === 'friends' || a === 'followers';
export const guestCirclesTitle = (a: Audience): string => (a === 'followers' ? 'Include Followers of People in It' : 'Include Friends of People in It');
export const guestCirclesHelper = (a: Audience): string => (a === 'followers' ? 'Followers of people in it can see it too.' : 'Friends of people in it can see it too.');

// The Hide switches' lines (ruled 2026-11-24: what each hides, and from whom;
// people in the moment always see these).
export const HIDE_HELPER = {
  place: 'Hides the address from people outside this moment.',
  details: 'Hides them from people outside this moment.',
} as const;

// The ⓘ beside "Who Can See This Moment" (ruled 2026-11-24): what the setting does.
export const WHO_CAN_SEE_INFO = 'Choose who outside this moment can open it from posts, profiles and links. To join, they still need the code. People in it only appear if their own privacy settings allow it.';

// A frozen moment (no signed-in host) can only be narrowed: a wider audience
// is off the list.
export const widerThan = (a: Audience, current: Audience): boolean => AUDIENCE_ORDER.indexOf(a) > AUDIENCE_ORDER.indexOf(current);
