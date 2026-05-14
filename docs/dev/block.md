# Profile blocking (`user_blocks`) — implementation

User-facing copy: `../block.md`.

Per-pair invisibility: stronger than mute. Outside sessions, bidirectional invisibility — A blocks B → they vanish from each other's feed, search, profile reads, follower/following lists and counts, likes, tags, "had a sip" flow. Inside shared sessions, block goes render-only (locked design — block is a UI primitive, not a secrecy mechanism inside a shared tasting).

## Schema

`user_blocks(blocker_id, blocked_id, created_at)`, composite PK, CHECK forbidding self-block, FK ON DELETE CASCADE both sides, index on `blocked_id` for reverse cascade. **Non-destructive**: blocking does NOT delete follows, mutes, likes, or tags between the pair. Unblock restores visibility everywhere.

## Authorization chokepoints (`lib/userBlock.ts`)

- `anyBlockBetween(a, b)` — OR'd both directions. Fast-path primitive used by `viewerCanSeeAuthor` to short-circuit visibility resolution.
- `viewerBlocksAuthor` / `authorBlocksViewer` — directional checks for shaping the gate result (`blocked-by-me` for the blocker, `gone` for the blocked).
- `blockPairIds(userId)` — `{ blockedByMe, blockingMe }` Sets, capped at 1000 per direction. Hot-path filter set for feed, search, in-session participant matrix.
- `setBlock(blockerId, blockedId, mute)` — single sanctioned write path. POST rate-limited 30/h/user; DELETE intentionally uncapped (recovery from a stolen-cookie burst must always work). FK violation swallowed.

## Resolver tri/quad-state

`resolveProfileViewer` now returns `{status: 'ok' | 'shell' | 'blocked-by-me' | 'gone', …}`. The block check runs **before** the visibility tier — block is the strictest primitive. `authorBlocksViewer` collapses to `'gone'` so the blocked viewer can't distinguish "I was blocked" from "user doesn't exist." Sub-routes (`/followers`, `/following`, `/badges`) gate on `status === 'ok'` so any non-ok state → 404.

## Mutual-block resolver behaviour

When A and B have blocked each other, both directions of the check fire and `authorBlocksViewer` is evaluated first in the route, so **both sides resolve to `'gone'` (404)** — neither party gets the `'blocked-by-me'` stripped view on `/u/<id>`. Locked intent: mutual block treats the other as "anon-equivalent" everywhere, including profile reads, mirroring the in-session participants matrix where mutual rows render anon-style with no `[blocked]` marker on either side. The blocker reaches unblock via **Settings → Blocked users**, which is always available regardless of resolver state.

## Counts are globally subtracted, not per-viewer

Locked design ("Instagram-style"):
- Like counts: a like by user X on a check-in by author Y is invisible to ALL viewers once a block exists between X and Y. Implemented via a batched `COUNT(DISTINCT cl.user_id)` SQL query that handles mutual A↔B blocks correctly.
- Follower / following counts: same — block-pair edges drop from the count shown to every viewer.
- Tag rendering: block-pair tags hidden from everyone (feed uses an `authorId:tagUserId` lookup set; profileLoad uses an owner-anchored set).

The single underlying rule: counts and renders depend on the **author** (or check-in owner), not the viewer. A SET-based deduplication in `lib/profileLoad.ts` prevents mutual-block from double-counting.

## Inside-session rules (render-only)

Locked matrix in the participants list (`SessionPanel`) — no row is ever hidden:
- Third party → both shown normally.
- Blocker viewing blocked (any tier: host, cohost, non-host) → `[blocked] {name}` + role badge, clickable to open `ProfilePreviewInline` with inline unblock.
- Blocked viewing blocker (any tier) → anon-style: plain name + role badge if any, no bold, no avatar, no link.
- Mutual block (A blocks B and B blocks A) → anon-style with **no `[blocked]` prefix** on either side. Both sides treat the other as an anon participant; unblock is reachable from the other user's `/u/<id>` page or settings → Blocked users. The prefix is suppressed because surfacing it on mutual would signal "this identifiable person blocked you back."
- Cohost role-toggle (`make co-host` / `remove role`) stays available to the host on block-pair rows. Block is a UI primitive, not a moderation one — kick/ban is the separate moderation primitive (see `docs/dev/kick-ban.md`).

Compare screen does **not** filter block-pair raters. Filtering by absence would itself be a leak — the blocked side would see the blocker's column missing and infer the block. Every rater appears under their plain display name; Compare has no profile-link or avatar surfaces, so there's nothing to strip beyond the participants-list treatment that already governs identity tells outside this view.

## Wine modal "Brought by" callout

(`WineInfoPane` inside `WineModal`) follows the participants-list matrix with two divergences:
- **No `[blocked]` prefix.** That marker stays exclusive to the participants list. Here, block state surfaces only through the lack of clickability + the plain (not bold/accent) name styling. Unblock is still reachable via the user's `/u/<id>` page or Settings → Blocked users.
- **Avatar always renders** (initial letter), including for anon-style modes (mutual block, being-blocked-by-adder). Since anon participants in this surface render WITH an avatar, dropping the avatar for a blocked user would itself leak the block — the absence is the tell. So the blocked side renders visually identical to a regular anon participant: avatar + plain name + no link. Same rule will eventually need to land in SessionPanel once anon participants there gain avatars; until then `docs/block.md`'s "no avatar" line is participants-list-specific.

Click rules unchanged: clickable + blocked-by-me modes open `ProfilePreviewInline` inline below the callout. Anon-style + plain modes have no click. Anon viewers can't click any mode.

`/api/session/[code]` GET adds `viewerBlocksOut` + `viewerBlocksIn` arrays (identity-ids, scoped to in-session participants only — never the viewer's full block list). Anon viewers get empty arrays. Response has `Cache-Control: private, no-store` since it varies by viewer.

## Follow endpoint scenarios

12a (blocker→blocked) returns explicit 400; 12b (blocked→blocker) returns uniform 200 silent no-op so the blocked side can't infer the block via response code. Both checks run in `Promise.all`.

## SECURITY: don't log `viewerBlocksOut`/`viewerBlocksIn`

These arrays carry the viewer's block-pair list scoped to a session. They must not be mirrored to analytics, stored in shared cache, or persisted outside the response.

## Out of scope (separate primitive)

Kick / ban — see [kick-ban.md](./kick-ban.md). Different intent, different scope. The two never interact.
