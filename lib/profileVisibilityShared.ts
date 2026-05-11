// Client-safe profile-visibility primitives: types, the union-validator
// predicate, the default tier, and UI display strings. No imports from
// `prisma` / `redis` / `rateLimit` so this module can be bundled into
// client components (AccountSettings).
//
// `lib/profileVisibility.ts` re-exports these for server-side consumers
// so the rest of the codebase keeps importing from one place.

export type ProfileVisibility =
  | 'public-internet'
  | 'public-users'
  | 'public-followers'
  | 'public-mutual'

// Display order in pickers (broadest to strictest). Also serves as the
// canonical tier list — `isProfileVisibility` validates against this so
// adding a tier means one place to update.
export const TIER_ORDER: ProfileVisibility[] = [
  'public-internet',
  'public-users',
  'public-followers',
  'public-mutual',
]

export function isProfileVisibility(v: unknown): v is ProfileVisibility {
  return typeof v === 'string' && (TIER_ORDER as string[]).includes(v)
}

// New-user default. Existing users on the privacy-tiers branch were
// migrated to 'public-internet' explicitly to preserve their de-facto
// state; only fresh signups land here.
export const DEFAULT_VISIBILITY: ProfileVisibility = 'public-users'

// UI display strings used by AccountSettings (settings picker). Co-located
// with the union so adding a tier means one place updates all surfaces.
export const TIER_LABELS: Record<ProfileVisibility, { title: string; sub: string }> = {
  'public-internet':  { title: 'Everyone',         sub: 'anyone with the link, including search engines' },
  'public-users':     { title: 'Verre users',      sub: 'any logged-in Verre user' },
  'public-followers': { title: 'My followers',     sub: 'only people who follow me' },
  'public-mutual':    { title: 'Mutual follows',   sub: 'only people I follow back' },
}
