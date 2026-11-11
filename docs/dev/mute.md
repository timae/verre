# Mute (`user_mutes`) — implementation

User-facing copy: `../mute.md`.

Per-pair soft-hide: A mutes B → A no longer sees B's content in A's feed. B is unaware. Independent of follow state, profile visibility, search, direct profile reads, likes, tags, and sessions — feed-only filter.

- `user_mutes(muter_id, muted_id, created_at)`, composite PK, CHECK forbidding self-mute, FK CASCADE both sides. No data on the row beyond the edge itself.
- `lib/userMute.ts` is the single sanctioned write path. `setMute` is rate-limited 60/h/user (shared POST + DELETE). FK violation on a non-existent target is swallowed to return uniform success — closes the user-id enumeration oracle.
- `/api/feed` Promise.all-batches `mutedUserIds(viewerId)` alongside the visibility check; the mute set is subtracted from `allowedNetworkIds` before the cursor query. Mute composes with the visibility tier filter — both must pass.
- `viewerMutes` flag is surfaced in `/api/users/[id]` full payload + the SSR `/u/[id]` render. Only meaningful on the non-shell / non-blocked view. The mute toggle in the UI lives behind the 3-dot menu on `ProfileHeader` (alongside Block).
- **The muter's own list**: `GET /api/me/mutes` (`listMutedUsers`) → `{ mutes: [{ id, name, createdAt }] }`, newest first, capped at 1000 (the block-list cap), `private, no-store`, 60/min/user (`rl:mutes-read`). Powers the app's Settings → Privacy → Muted (the only way back to a muted person you don't follow). 🔒 A muted user who has BLOCKED the muter is left out: their profile is `'gone'` to the muter, and listing them would tell "blocked me" apart from "deleted" (`docs/dev/block.md`). One the muter blocked stays. No `imageUrl` (rows are initials, which sidesteps the avatar tier gate). Pinned in `scripts/tests/you-profile-integration.mts` § 6.
- TanStack Query invalidation on toggle: `['user-profile', userId]` (refresh viewerMutes flag), `['feed']` (refresh feed filter). Wired in `UserProfileModal` / `ProfilePreviewInline` / the `ProfileActionsMenu` consumer chain.
