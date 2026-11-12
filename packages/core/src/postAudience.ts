// Post Visibility vs Account Visibility (You profile step 4): the ONE rule the
// app's Privacy page and the server's visibility write (`setProfileVisibility`,
// lib/profileVisibility.ts) both apply, so they can't drift. Pinned against the
// server's `canViewPosts` for every state × viewer × change by
// scripts/tests/you-profile-integration.mts § 15.
//
// The extended circle (`fofEnabled`) only applies to the two strict tiers
// (Followers of Followers / Friends of Friends); a stored one rides along
// hidden under the others. An explicit posts tier never includes it.

export type AccountTier = 'public-internet' | 'public-users' | 'public-followers' | 'public-mutual'
export type StrictTier = 'public-followers' | 'public-mutual'
export type PostTier = 'public-users' | 'public-followers' | 'public-mutual' | 'only-me'
export type AudienceSettings = { visibility: AccountTier; fofEnabled: boolean; checkinVisibility: PostTier | null }

const BREADTH: Record<AccountTier | PostTier, number> = {
  'public-internet': 0, 'public-users': 1, 'public-followers': 2, 'public-mutual': 3, 'only-me': 4,
}
export const postsBroaderThanAccount = (c: PostTier, account: AccountTier) => BREADTH[c] < BREADTH[account]
export const postsSameTierAsAccount = (c: PostTier, account: AccountTier) => c !== 'only-me' && BREADTH[c] === BREADTH[account]
export const extendedCircleApplies = (v: AccountTier): v is StrictTier => v === 'public-followers' || v === 'public-mutual'
export const extendedCircleOn = (s: Pick<AudienceSettings, 'visibility' | 'fofEnabled'>) => extendedCircleApplies(s.visibility) && s.fofEnabled

// 🔒 Never a wider audience by it (ruled 2026-11-11). A posts choice whose
// audience EQUALS the account's IS Same as Account (null): without the
// extended circle, any choice as wide as the account or wider (limited to it
// anyway); WITH the circle on, only Verre Users (Followers under Friends +
// circle keeps out circle members who don't follow you: narrower, not equal).
const postsSameAudienceAsAccount = (c: PostTier, s: AudienceSettings) =>
  c !== 'only-me' && (extendedCircleOn(s) ? c === 'public-users' : BREADTH[c] <= BREADTH[s.visibility])

// The exact collapse only: who sees what never changes, so it is safe on any
// READ (display, the server's settings read).
export function canonicalPostAudience<S extends AudienceSettings>(s: S): S {
  return s.checkinVisibility && postsSameAudienceAsAccount(s.checkinVisibility, s) ? { ...s, checkinVisibility: null } : s
}

// The settings a SAVE produces: from what the owner sees (`base`, collapsed),
// `changes` applied, the exact collapse, and when the tier or the
// circle actually changes value, the clamp: a choice still wider than the
// account while the circle is on becomes the account's tier ("without
// friends of friends"), which only narrows. An unrelated change (a Show
// switch, the same tier picked again) never touches the posts choice. 🔒 The
// clamp lives only here: a read never narrows a stored audience.
export function applyVisibilityChanges<S extends AudienceSettings>(base: S, changes: Partial<S>): S {
  const shown = canonicalPostAudience(base)
  const next = canonicalPostAudience<S>({ ...shown, ...changes })
  const accountChanged = next.visibility !== shown.visibility || next.fofEnabled !== shown.fofEnabled
  const c = next.checkinVisibility
  if (!accountChanged || !c || !extendedCircleApplies(next.visibility) || !next.fofEnabled || !postsBroaderThanAccount(c, next.visibility)) return next
  return { ...next, checkinVisibility: next.visibility }
}
