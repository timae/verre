import { canonicalPostAudience, extendedCircleOn, postsBroaderThanAccount } from '@verre/core';
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

// A taster's read-only summary of the section (ruled 2026-11-25, R14: anyone
// who can't change it reads values, not disabled switches). The circle is
// named by WHO it is, no helper: with the people-in-it switch on (the default)
// it is theirs, the host included (lib/momentAudience.ts: the host's edge, or
// a named member's); off, the host's alone. With Only People in It, Visible To
// alone (nobody outside sees the moment).
export const OUTSIDE_SUMMARY_LINE = 'What people outside this moment can see.';
export function audienceSummaryLabel(a: Audience, includeCircles: boolean): string {
  if (!guestCirclesApply(a)) return audienceLabel(a, 'other');
  if (!includeCircles) return audienceLabel(a, 'other');
  return a === 'followers' ? 'Followers of People in It' : 'Friends of People in It';
}
export const shownOrHidden = (shown: boolean): string => (shown ? 'Shown' : 'Hidden');

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

// ── Step 3: your own choices (ruled 2026-11-24/25, R1–R3, R5, R11, R12) ────
// The Moment Privacy section for everyone in the moment: Incognito (R11, the
// stored `onlyInside`) and Hide from Feed for your post of it (R12).
export const WHO_CAN_SEE_YOU = 'Who Can See You';
export const ONLY_INSIDE_TITLE = 'Incognito';
export const ONLY_INSIDE_HELPER = 'Hides you and your post from everyone outside this moment, even friends and followers.';
// Who outside the moment sees you by name (ruled 2026-11-25, R15: your OWN
// account privacy limits it, whatever the host chose). The block at the top of
// "Who Can See You": a lead, the value, maybe a note, and the link to Account
// Privacy (Simon's structure, Codex's words, round 2 option 1). The value is
// your post audience (core's rule: the stricter of Account and Post
// Visibility; the extended circle only while posts follow the account): you
// are named only to it (`lib/momentAudience.ts`, the post gate). Show Moments
// does NOT change it (your moment posts still reach that audience). Never
// fewer people than the truth: an explicit post choice wider than the account
// reads as the account's audience.
export const OWN_AUDIENCE_LINK = 'Change Account Privacy';
export const ACCOUNT_PRIVACY_TITLE = 'Account Privacy';
type AccountTier = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual';
type OwnAudience = { visibility: AccountTier; fofEnabled: boolean; checkinVisibility: 'public-users' | 'public-followers' | 'public-mutual' | 'only-me' | null };
const TIER_NAME: Record<AccountTier, string> = { 'public-internet': 'Everyone', 'public-users': 'Verre Users', 'public-followers': 'Your Followers', 'public-mutual': 'Your Friends' };
export function outsideNameLabel(s: OwnAudience): string {
  const c = canonicalPostAudience(s);
  if (c.checkinVisibility === 'only-me') return 'Only Me';
  if (c.checkinVisibility && !postsBroaderThanAccount(c.checkinVisibility, c.visibility)) return TIER_NAME[c.checkinVisibility];
  if (extendedCircleOn(c)) return c.visibility === 'public-mutual' ? 'Your Friends and Their Friends' : 'Your Followers and Their Followers';
  return TIER_NAME[c.visibility];
}
export type OwnAudienceBlock = { lead: string; value: string; note?: string };
export function ownAudienceBlock(s: OwnAudience, incognito: boolean): OwnAudienceBlock {
  if (incognito) return { lead: 'Who can see you by name outside this moment:', value: 'No one (Incognito is on)' };
  const value = outsideNameLabel(s);
  if (value === 'Only Me') return { lead: 'Your posts are set to:', value, note: 'People outside this moment won’t see you by name. People in it still see you.' };
  return { lead: 'Your account privacy settings also limit who outside this moment can see you by name:', value };
}
export const MOMENT_HIDE_FROM_FEED_TITLE = 'Hide from Feed';
export const MOMENT_HIDE_FROM_FEED_HELPER = 'Only you see your post of this moment. This doesn’t hide your impressions.';
// Your own post's ⋯ row (Title Case, a check while on) and the status line
// under your name (sentence case, like "Hidden from guests"). Hide from Feed
// only: Incognito is set on Moment Privacy and never shows on a post (R13).
export const POST_PRIVACY_COPY = {
  hiddenFromFeed: { row: 'Hide from Feed', line: 'Hidden from feeds' },
} as const;
