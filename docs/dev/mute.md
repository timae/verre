# Mute (`user_mutes`) — implementation

User-facing copy: `../mute.md`.

Per-pair soft-hide: A mutes B → A no longer sees B's content in A's feed. B is unaware. Independent of follow state, profile visibility, search, direct profile reads, likes, tags, and sessions — feed-only filter.

- `user_mutes(muter_id, muted_id, created_at)`, composite PK, CHECK forbidding self-mute, FK CASCADE both sides. No data on the row beyond the edge itself.
- `lib/userMute.ts` is the single sanctioned write path. `setMute` is rate-limited 60/h/user (shared POST + DELETE). FK violation on a non-existent target is swallowed to return uniform success — closes the user-id enumeration oracle.
- `/api/feed` Promise.all-batches `mutedUserIds(viewerId)` alongside the visibility check; the mute set is subtracted from `allowedNetworkIds` before the cursor query. Mute composes with the visibility tier filter — both must pass.
- `viewerMutes` flag is surfaced in `/api/users/[id]` full payload + the SSR `/u/[id]` render. Only meaningful on the non-shell / non-blocked view. The mute toggle in the UI lives behind the 3-dot menu on `ProfileHeader` (alongside Block).
- TanStack Query invalidation on toggle: `['user-profile', userId]` (refresh viewerMutes flag), `['feed']` (refresh feed filter). Wired in `UserProfileModal` / `ProfilePreviewInline` / the `ProfileActionsMenu` consumer chain.
