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
  if (a === 'members') return 'Only People Who Joined';
  if (a === 'verre') return 'Verre Users';
  const whose = who === 'host' ? 'Your' : 'Host’s';
  return a === 'friends' ? `${whose} Friends` : `${whose} Followers`;
}

// The circles of the people in the moment: a switch for Friends and Followers
// only. "People Who Joined", like the audience option (ruled 2026-11-24 as "People
// in It", not "guests"; "joined" ruled 2026-11-25: easier to picture).
export const guestCirclesApply = (a: Audience): boolean => a === 'friends' || a === 'followers';
export const guestCirclesTitle = (a: Audience): string => (a === 'followers' ? 'Include Tasters’ Followers' : 'Include Tasters’ Friends');
export const guestCirclesHelper = (a: Audience): string => (a === 'followers' ? 'Followers of people who joined can see it too.' : 'Friends of people who joined can see it too.');

// A taster's read-only summary of the section (ruled 2026-11-25, R14: anyone
// who can't change it reads values, not disabled switches). The circle is
// named by WHO it is, no helper: with the people-in-it switch on (the default)
// it is theirs, the host included (lib/momentAudience.ts: the host's edge, or
// a named member's); off, the host's alone. With Only People in It, Visible To
// alone (nobody outside sees the moment).
export const OUTSIDE_SUMMARY_LINE = 'What people who haven’t joined can see.';
export function audienceSummaryLabel(a: Audience, includeCircles: boolean): string {
  if (!guestCirclesApply(a)) return audienceLabel(a, 'other');
  if (!includeCircles) return audienceLabel(a, 'other');
  return a === 'followers' ? 'Followers of People Who Joined' : 'Friends of People Who Joined';
}
export const shownOrHidden = (shown: boolean): string => (shown ? 'Shown' : 'Hidden');

// The Hide switches' lines (ruled 2026-11-24: what each hides, and from whom;
// people in the moment always see these).
export const HIDE_HELPER = {
  place: 'Only people who joined can see the address.',
  details: 'Only people who joined can see them.',
} as const;

// The ⓘ beside "Who Can See This Moment" (ruled 2026-11-24): what the setting does.
export const WHO_CAN_SEE_INFO = 'Choose who can open this moment from posts, profiles and links without joining. To join, they still need the code. Each taster’s privacy settings control who can see their name. Hidden tasters are only counted, not named.';

// A frozen moment (no signed-in host) can only be narrowed: a wider audience
// is off the list.
export const widerThan = (a: Audience, current: Audience): boolean => AUDIENCE_ORDER.indexOf(a) > AUDIENCE_ORDER.indexOf(current);

// ── Step 3: your own choices (ruled 2026-11-24/25, R1–R3, R5, R11, R12) ────
// The Moment Privacy section for everyone in the moment: Incognito (R11, the
// stored `onlyInside`) and Hide from Feed for your post of it (R12).
export const WHO_CAN_SEE_YOU = 'Who Can See You';
export const ONLY_INSIDE_TITLE = 'Incognito';
export const ONLY_INSIDE_HELPER = 'Hides you and your post from everyone who hasn’t joined, even friends and followers.';
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
  if (incognito) return { lead: 'Who can see your participation without joining:', value: 'No one (Incognito)' };
  const value = outsideNameLabel(s);
  if (value === 'Only Me') return { lead: 'Your posts are set to:', value, note: 'Only people who joined this moment can see your participation.' };
  return { lead: 'Your account privacy settings limit who can see your participation without joining:', value };
}
export const MOMENT_HIDE_FROM_FEED_TITLE = 'Hide from Feed';
export const MOMENT_HIDE_FROM_FEED_HELPER = 'Only you can see your post. Your impressions stay visible on your profile.';
// Your own post's ⋯ row (Title Case, a check while on) and the status line
// under your name (sentence case, like "Hidden from guests"). Hide from Feed
// only: Incognito is set on Moment Privacy and never shows on a post (R13).
export const POST_PRIVACY_COPY = {
  hiddenFromFeed: { row: 'Hide from Feed', line: 'Hidden from feeds' },
} as const;

// ── Step 3b: "Private Moment" (ruled 2026-11-25, R16–R19) ──────────────────
// A moment's name, outside the moment, only for someone who could open it;
// everyone else reads the label (R18), never tappable. The server decides
// (`privateMoment` on a post or an Impressions row); these only word it.
export const PRIVATE_MOMENT = 'Private Moment';
// The "where" of a moment post: the card's byline and the opened post's place.
export function momentPlace(s: { deleted: boolean; privateMoment?: true; sessionName: string | null }): string | null {
  if (s.deleted) return '[deleted moment]';
  if (s.privateMoment) return PRIVATE_MOMENT;
  // An empty legacy name reads as none (no stray " · " before the time).
  return s.sessionName || null;
}
// A blind Impressions row's line is its moment (what the post shows).
export const blindRowLine = (row: { momentName?: string; privateMoment?: true }): string | null =>
  row.momentName ?? (row.privateMoment ? PRIVATE_MOMENT : null);
// The note under "Who Can See You"'s account block (R19, Simon's literal edit
// of Codex's option 2): what people outside see of your post. Only while it
// can say something true: signed in (a guest has no posts), not Incognito,
// Hide from Feed off, your posts not Only Me. By the SERVED Visible To alone
// (R19: Only People in It → the first; any other → the second; for Verre Users
// the "can't open" ones are signed-out web visitors). A frozen moment (its
// host deleted their account) keeps its audience and can still be opened, so
// it reads by its Visible To like any other (build review 2026-11-25; a
// guest-hosted one is Only People in It by the database).

export const PRIVATE_MOMENT_NOTE = {
  members: 'Your post stays visible to people in this audience who haven’t joined, as ‘Private Moment’ instead of the moment’s name.',
  other: 'Your post stays visible to this audience, as ‘Private Moment’ for anyone who can’t open this moment.',
} as const;
// The note sits behind an ⓘ after your audience (Simon, phone look
// 2026-11-25); VoiceOver names the button by what it explains.
export const PRIVATE_MOMENT_INFO_LABEL = 'How people who haven’t joined see your post';
export function privateMomentNote(o: { signedIn: boolean; onlyInside: boolean; hiddenFromFeed?: boolean; postsOnlyMe: boolean; visibility: Audience | null }): string | null {
  if (!o.signedIn || o.onlyInside || o.hiddenFromFeed === true || o.postsOnlyMe) return null;
  return o.visibility === null || o.visibility === 'members' ? PRIVATE_MOMENT_NOTE.members : PRIVATE_MOMENT_NOTE.other;
}

// ── Moment Defaults (plan § 6, picked by Simon 2026-11-25) ───────────────────
// Your own defaults, COPIED when you create or join a moment or check in
// (never live). Split by Simon (2026-11-25): "who can see you is a privacy
// setting, while who can see moments you created is a moment default". So
// Settings → Privacy holds your join defaults (Incognito, Hide from Feed) and
// the check-ins' Hide from Feed (under Post Visibility); Settings → the
// moments area → Moment Defaults holds the moments you create. No line about
// "past choices" on either (dropped by Simon: the titles say when, the alert
// says the rest). The rows reuse the Moment Privacy words.
// The Settings hub row + its page (the design's "Tasting" placeholder; no
// "tasting": the app never says it; picked by Simon 2026-11-25).
export const MOMENTS_AREA_TITLE = 'Moments & Check-Ins';
export const WHO_CAN_SEE_THIS_MOMENT = 'Who Can See This Moment';
export const MOMENT_DEFAULTS_SECTIONS = {
  // "Create", not "Host" (Simon, 2026-11-25): a default is copied when you create a moment.
  host: 'Who Can See Moments You Create',
  // Privacy's section of your join default, Incognito (picked by Simon,
  // 2026-11-25; the moment posts' Hide from Feed sits in Post Visibility).
  join: 'Joining or Creating Moments',
} as const;
// The check-ins' default switch, under Privacy → Post Visibility (no "New":
// changing it offers to apply to existing check-ins too; picked by Simon
// 2026-11-25).
export const CHECKIN_HIDE_FROM_FEED_TITLE = 'Hide Check-Ins from Feed';
// Both helpers name YOUR posts of that kind (Simon, 2026-11-25: "be clear in
// the helper text that it is about your check-ins and your moment posts").
export const CHECKIN_HIDE_FROM_FEED_HELPER = 'Only you can see your check-in posts. Your impressions still show on your profile.';
// The moment posts' default switch, beside it in Post Visibility (Simon's
// grouping, 2026-11-25; Codex's pick): copied when you join or create a moment.
export const MOMENT_POSTS_HIDE_FROM_FEED_TITLE = 'Hide Moment Posts from Feed';
export const MOMENT_POSTS_HIDE_FROM_FEED_HELPER = 'Only you can see your moment posts. Your impressions still show on your profile.';
// The check-in rate stage's switch (§ 6 item 9).
export const RATE_HIDE_FROM_FEED_HELPER = 'Only you can see the post. Your impression still shows on your profile.';

// The alert after ONE default changed, when something you have differs (D3):
// two buttons, the apply only on the second. `existing` = the PATCH's preview.
export type DefaultsPreview = { field: string; count: number; wider: number; narrower: number };
const moments = (n: number) => (n === 1 ? '1 moment' : `${n} moments`);
const checkins = (n: number) => (n === 1 ? '1 check-in' : `${n} check-ins`);
export function applyDefaultAlert(p: DefaultsPreview): { title: string; message: string; keep: string; all: string } {
  if (p.field === 'checkinHiddenFromFeed') {
    return {
      title: 'Apply to Existing Check-Ins?',
      message: `${checkins(p.count)} would be ${p.narrower > 0 ? 'hidden' : 'shown'}.`,
      keep: 'New Check-Ins Only',
      all: p.count === 1 ? 'Include Existing Check-In' : `All ${p.count} Check-Ins`,
    };
  }
  const message = p.wider > 0 && p.narrower > 0
    ? `${moments(p.count)} ${p.count === 1 ? 'has' : 'have'} a different setting.\n${p.wider} would open wider and ${p.narrower} would narrow.`
    : `This would ${p.wider > 0 ? 'increase' : 'reduce'} visibility for ${moments(p.count)}.`;
  // One item: "Include Existing …" (Simon picked Codex's option, 2026-11-25:
  // "All 1 Moment" read oddly).
  return { title: 'Apply to Existing Moments?', message, keep: 'New Moments Only', all: p.count === 1 ? 'Include Existing Moment' : `All ${p.count} Moments` };
}

// Create Moment's Privacy row (D4, § 6 item 7): the ACTUAL values, never
// "Default". Line 1 the audience (+ the tasters' circle when it applies and is
// on); line 2 what people who haven't joined can see (location, then
// description and link; only when the audience reaches anyone outside), then
// your own Incognito / hidden from feeds. Line 2 is PHRASES: the row keeps the
// whole ones that fit and ends with an ellipsis (components: FitPhrases).
export type CreatePrivacyValues = { visibility: Audience; includeGuestCircles: boolean; showPlace: boolean; showDetails: boolean; onlyInside: boolean; hiddenFromFeed: boolean };
export function createPrivacyLines(p: CreatePrivacyValues): { first: string; phrases: string[] } {
  const circle = guestCirclesApply(p.visibility) && p.includeGuestCircles ? (p.visibility === 'followers' ? ' + tasters’ followers' : ' + tasters’ friends') : '';
  const shown = p.visibility === 'members' ? [] : [p.showPlace ? 'location' : null, p.showDetails ? 'description and link' : null].filter((s): s is string => !!s);
  const phrases = [
    shown.length ? `${shown.join(', ')} shown` : null,
    // "Incognito on", only while on (Simon, 2026-11-25).
    p.onlyInside ? 'Incognito on' : null,
    p.hiddenFromFeed ? 'hidden from feeds' : null,
  ].filter((s): s is string => !!s);
  return { first: `${audienceLabel(p.visibility, 'host')}${circle}`, phrases };
}
// Line 2 from the first `keep` phrases: the first letter up, ` · ` between,
// an ellipsis when some were left out.
export function phraseLine(phrases: string[], keep = phrases.length): string {
  const kept = phrases.slice(0, Math.max(1, keep));
  const s = kept.join(' · ') + (kept.length < phrases.length ? ' …' : '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// D1: the line under a moment's date while YOU are Incognito or hidden from
// feeds there (whatever set it: a default, a hand choice, promotion), with
// the struck-through eye first and "Change" opening Moment Privacy (§ 6 item 8).
export const MOMENT_STATUS_CHANGE = 'Change';
export function momentStatusLine(me: { onlyInside: boolean; hiddenFromFeed?: boolean } | null | undefined): string | null {
  if (!me) return null;
  if (me.onlyInside && me.hiddenFromFeed) return 'Incognito · hidden from feeds';
  if (me.onlyInside) return 'Incognito';
  if (me.hiddenFromFeed) return POST_PRIVACY_COPY.hiddenFromFeed.line;
  return null;
}
