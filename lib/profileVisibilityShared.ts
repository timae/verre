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

// Check-Ins Visible To (You, step 4): the audience for the owner's POSTS,
// stored beside the profile tier; the stricter of the two wins on read
// (`canViewPosts`, lib/profileVisibility.ts), and a save keeps it canonical
// (`applyVisibilityChanges`, @verre/core: equal to the account = NULL).
// NULL (not a member of this union) = Same as Profile. 'public-internet' is
// never stored (it would equal NULL), and an explicit tier never uses FoF.
// 'only-me' = a private diary: nobody but the owner sees the posts.
export type CheckinVisibility = Exclude<ProfileVisibility, 'public-internet'> | 'only-me'

export const CHECKIN_TIER_ORDER: CheckinVisibility[] = [
  'public-users',
  'public-followers',
  'public-mutual',
  'only-me',
]

export function isCheckinVisibility(v: unknown): v is CheckinVisibility {
  return typeof v === 'string' && (CHECKIN_TIER_ORDER as string[]).includes(v)
}

// The owner's six visibility settings (GET /api/me/visibility, the PATCH's
// `expected` + `current`, the gate's `settings`). Client-safe: the web form
// keeps them as its compare-and-set snapshot.
export interface VisibilitySettings {
  visibility: ProfileVisibility
  fofEnabled: boolean
  checkinVisibility: CheckinVisibility | null  // null = Same as Profile
  showCravings: boolean
  showMoments: boolean
  showLocations: boolean
}

// Every field, exhaustively (a Record over the keys: a new setting that isn't
// listed here fails tsc, so the PATCH's compare can't skip it). ⚠️ A NEW
// field must be optional in the PATCH's `expected` and compared only when
// sent, or every client built before it (open web tabs, installed apps) 400s
// on every save.
const FIELDS: Record<keyof VisibilitySettings, true> = {
  visibility: true, fofEnabled: true, checkinVisibility: true, showCravings: true, showMoments: true, showLocations: true,
}
export const VISIBILITY_FIELDS = Object.keys(FIELDS) as (keyof VisibilitySettings)[]
