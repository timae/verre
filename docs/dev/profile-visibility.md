# Profile visibility — implementation

User-facing copy: `../profile-visibility.md`.

Per-user setting controlling who can read profile content (`/u/<id>` page, `/api/users/<id>` and sub-routes, feed entries authored by this user, check-in like POSTs). Stored on `users` as two columns:

- `profile_visibility VARCHAR(32)` — one of `public-internet` / `public-users` / `public-followers` / `public-mutual`. CHECK constraint hand-added in the migration; **the TypeScript union in `lib/profileVisibility.ts` is the authoritative source of truth**, the CHECK is belt-and-suspenders.
- `visibility_fof BOOLEAN` — when true, friend-of-follower (depth 1: viewer→intermediary→profile) is also admitted. Only meaningful for `public-followers` and `public-mutual`; `public-internet` and `public-users` already admit anyone qualifying via FoF.

## Tier semantics (locked)

- `public-internet` — anyone, no auth required. Profile + check-ins indexable by search engines.
- `public-users` — any logged-in Verre user. **Default for new signups.**
- `public-followers` — only people who follow the profile owner (asymmetric: owner doesn't have to follow back).
- `public-mutual` — only mutual follows (both directions of `follows`).

## Default migration (existing users)

The privacy-tiers migration `UPDATE`s pre-existing rows to `public-internet` to preserve their de-facto state, and only NEW rows hit the column default `public-users`. Don't change this without surfacing the retroactive-tightening question to the user — silent default changes break shared profile URLs.

## Authorization chokepoints — never bypass

- `lib/profileVisibility.ts` `resolveProfileViewer(profileId, viewerId)` — single-profile gate. Returns `{status: 'ok' | 'shell' | 'blocked-by-me' | 'gone', …}` (plus `name` for `shell`/`blocked-by-me`, `viewer` for `ok`). Map `status === 'gone'` to 404 (not 403, not 401) so the caller can't distinguish "no such user" from "exists but tier denies you" — that's the leak prevention.
- `viewerCanSeeAuthor(viewerId, authorId)` — per-pair gate for non-feed call sites (single check-in, like POST, etc.).
- `batchLoadVisibilities(ids)` + `resolveProfileViewerBulk(ids, viewerId)` + `viewerFofAuthorSet(viewerId, ids)` — batch path used by feed and search to avoid N+1 lookups.
- `setProfileVisibility(userId, tier, fof)` — the only sanctioned write path. Validates the union, enforces a 30/hour/user rate limit, writes user row + `profile_visibility_log` audit row in one transaction. Bypassing this and writing the column directly skips the audit trail.

## Hall of Fame stays public regardless of tier (deliberate decision)

`/hof` displays rater display names with no clickable user link; the leaderboard (Hall of Fame, HoF for short) is treated as a deliberately public surface. This means a `public-mutual` user with a 5★ rating still has their name visible on `/hof`. If product later wants HoF to honour the tier, that's a localized change — see `app/hof/page.tsx`. The leak is documented and accepted, not an oversight.

## Session compare views are NOT gated by profile visibility

Trust model: session participation > profile tier. If you joined a session together, you see each other's ratings and display names — `profile_visibility` only governs *outside-session* surfaces. Don't try to gate session ratings by profile_visibility; you'll break the compare screen.

## Tag display follows the check-in author's tier

…not the tagged user's. A user tagged in someone else's check-in appears according to that check-in's visibility — being tagged is a presentation surface the tagged user consented to via mutual-follow at creation time. Edit-time mutual-follow re-validation already drops a tag if the relationship has been broken since.

## Audit log (`profile_visibility_log`)

Internal-only, no API surface, no UI. One row per change (tier or fof), plus an initial signup row with `from_tier=NULL` for forensic completeness. Cascade rule is `ON DELETE SET NULL` — the trail survives account deletion (tombstone pattern) so post-mortem queries can still reconstruct timelines for deleted users.
