# Moment Visibility

**Status:** SHIPPED. Built in steps 1a to 3b, released dark in 0.2.0 (2026-11-27), ON since 0.2.0 build 2 (2026-11-28: `MOMENT_LOOKIN_ENABLED` / `HIDE_FROM_FEED_ENABLED` on by default, `'false'` is the kill switch, `lib/momentGate.ts`). This file stays as the rationale-of-record; where the build deviates, `lib/CLAUDE.md` § Moment Visibility and `docs/dev/deployment.md` § Moment Visibility are the record. As built: the link carries a stored random code, not an HMAC (§ 4); the two naming questions (§ 14) were settled as "Verre Users" (ruled 2026-11-24) and "Hide Description and Link".

Proposed 2026-11-15, reviewed: Claude reviewers CONVERGED after three rounds (privacy, plan solidity, security), then Codex xhigh r1–r4 → "No material findings" (§ 17). Rulings from the planning interviews in § 2.

People can **look into** a moment without its code: the line-up, who was there, their scores and notes. Joining still needs the code, typed or scanned, which you get from someone in the tasting. A look-in is read-only, lives in the **app only**, and never shows the code.

## 1. Why

Moments are the social heart of Verre, but today a moment is invisible to anyone not in it: a friend sees your moment post in the feed, can't open the moment, and someone's profile only lists the moments you shared with them. Hosts should be able to let their circle look in, while the code stays the only key to join.

**Not goals:** joining without a code, a moment search, changing what people inside a moment see, guest-only moments (§ 6), the web beyond two small pieces (§ 2).

## 2. Ruled (interviews, 2026-11-15)

- **One setting, Moment Visibility**, in Moment Setup. The audience is the **host's** circle: Only People in It / Your Friends / Your Followers / Everyone on Verre. A switch under it widens to the **guests'** circles: "Include Friends of Guests" (with Your Friends) or "Include Followers of Guests" (with Your Followers).
- **Default for every new moment: Your Friends + Include Friends of Guests ON.** **Existing moments get the same default when this goes live, old 4-character ones included** (both flagged by Claude, kept: § 13).
- **Host and cohosts** may change it.
- **A look-in shows** the name, cover, date, line-up, who was there, scores and notes. **The place** has its own switch, "Show the Place", off by default. **The description and the moment's web link** share one switch, off by default (the default is assumed, like the place).
- **Each person's own settings win**, the host included. Someone the viewer may not see counts in "N more tasters". **A hidden host: the "Hosted by" line is left out**, in the look-in AND on feed posts.
- **Averages** use everyone's scores (accepted residual, § 13).
- **Entry points:** moment posts in the app's feed, someone's profile Moments list (moments you shared + moments open to you; "joined N other moments" counts the rest), and a **link** the host shares.
- **App only.** No look-in, no Moment Setup settings and no signed-out page on the web. A moment post on the web links only to its author (`components/social/SessionFeedCard.tsx:53`) and stays that way; it does follow the hidden-host rule, because the web reads the same `/api/feed`. The web gets exactly two things: the switch for guests without an account (they exist only on the web, below) and the static "Open in the Verre app" page a link lands on without the app (no moment data).
- **The link** contains no code, is **independent of Moment Visibility** (it works even on Only People in It), and Moment Setup shows its **status** ("Link active since 14 Nov") with **Turn Off** and **Reset**, for host and cohosts. **Banning someone while a link is active offers to reset it**; removing or kicking a cohost does not (ruled: the host resets by hand).
- **Live updates** while looking in.
- **Only moments with a record** (a signed-in host, or promoted) can be opened. Guest-only moments stay closed, and so does a guest-hosted moment after promotion (§ 5): no audience, no link, and its anonymous host can't change the setting.
- **Guests without an account** (web only: the app requires an account, `apps/mobile/src/app/_layout.tsx:224`) show by name with scores; a switch in the web's guest menu (`components/session/SessionAnonMenu.tsx`) hides them. Guests already in a moment at go-live get the same default (consistent with old moments opening).
- **Every person gets one per-moment switch, "Only Inside This Moment"**, in the moment's settings and on their moment post's ⋯ menu. They are counted, not shown, in look-ins; their post of the moment and the moment on their profile are visible only to the people in it; **after the moment is deleted, the post only to them**; their impressions from it still show to their usual audience, without the moment's name (accepted residual, § 13).
- **Kicked (not banned) viewers** may look in like anyone (assumed: they could rejoin with the code).

**Noted for later (not in this proposal):** a per-post audience on ordinary check-ins.

## 3. Superseded rulings

- Lists (2026-11-13): "someone's Moments = ONLY shared moments". Now: shared + open to you (§ 8). The 🔒 join safety stays: an open row carries no code.
- You profile step 4, Q4: "a moment's address stays for its participants". Now: Show the Place (host switch, off by default).
- Per-moment privacy options, noted as a later topic on 2026-11-13: this proposal is the moment half.
- The first interview's "the link works signed out" and "a signed-out web page": replaced the same day by app only.

## 4. Two addresses, neither of them the code

| Address | Who can use it | Lifetime |
|---|---|---|
| `sessions.public_id` (in-app) | the Moment Visibility audience | the moment's life |
| the link | any signed-in app user with it | until Reset / Turn Off |

They must be separate: if the in-app id were the link, everyone who sees the moment in a feed could forward it, and a reset would break every in-app reference.

- **`public_id`**: minted by a trigger and immutable, like `users.public_id` (`prisma/schema.prisma:31`); kept on a deleted moment's tombstone (it answers the same 404 as an unknown id). The feed keeps its integer `sessionId` (`app/api/feed/route.ts:321`): the app matches it against your own moments to enter one (`apps/mobile/src/lib/useEnterableMoment.ts:40`), and it grants nothing.
- **The link** is `…/l/<publicId>.<token>`, with `token = HMAC-SHA256(MOMENT_LINK_SECRET, "verre-moment-link-v1" ‖ 0x00 ‖ publicId ‖ 0x00 ‖ link_version)`, truncated to 128 bits. Nothing secret is stored. The state is two columns: `link_version` and `link_active`.
  - **As built (0.2.0 build 2, ruled 2026-11-27):** the HMAC and `MOMENT_LINK_SECRET` are gone. The token is a random code per link (16 bytes, 32 hex), stored on the moment as is (`sessions.link_code`, NULL while the link is off), so Share on an active link and the host's or cohost's settings read show the stored link again. Share on a link that is off creates a code, Reset replaces the code of an active link (Reset on a link that is off leaves it off, with no code), Turn Off clears it, and the presented code is compared in constant time (`lib/momentLink.ts`, `writeLinkAction` in `lib/momentSettings.ts`). The link format is unchanged. `link_version` stays, as a counter. The secret's fail-closed rule below no longer applies; the never-logged rule does.
  - 🔒 **The version only ever goes up.** **Reset** increments it. **Turn Off** sets `link_active` false and never touches the version. **Share** on a link that is off increments the version first, so turning a link back on never revives an earlier one (pinned in the suite: off → on validates no older link).
  - A read for host and cohosts (the grant) returns the current link, so a second Share (another device, a cohost) shows the same link without killing the first.
  - (As planned; as built the stored code is compared, see above.) The server checks a link by recomputing the token, with a constant-time compare. The limiter is charged before the `public_id` lookup, and the HMAC is computed for unknown ids too, so every refusal costs the same.
  - (As planned; no secret as built, see above.) 🔒 **The secret fails closed:** absent or shorter than 32 bytes → every link route answers 404 and the app logs it at boot. There is no fallback. It must be identical on every instance; rotating it kills every link (`docs/dev/deployment.md`).
  - 🔒 The token never enters meta, any cache, the app's logs or error reports: `/l/` paths are redacted where requests are logged. The static page's URL carries a live token, so it sends `Referrer-Policy: no-referrer` and loads no third-party resource. The platform proxy's own access logs are outside the app's reach (§ 13).
- 🔒 **No look-in or link route ever returns `code`** (the one exception is the member-only read below, which answers a member about their own membership). A member who opens a look-in or a link gets `member: true` and nothing else. The app takes the code from the caller's own membership through a member-only read, `GET /api/me/sessions/by-moment/:publicId`, which admits by the record's rule: a current, non-kicked, non-banned member gets their row; everyone else, kick-keep included, the same 404. This also covers a member whose moment is beyond the loaded page (`useEnterableMoment.ts:39-41` only matches rows already loaded).

## 5. Schema

One additive migration (`BEGIN` / `COMMIT`, `lock_timeout`, as the recent ones).

**`sessions`:**
- `public_id VARCHAR(12) NOT NULL UNIQUE`: mint trigger, immutability trigger, format CHECK, backfilled in the migration.
- `visibility VARCHAR(16) NULL DEFAULT 'friends'`, CHECK in (`members`, `friends`, `followers`, `verre`).
- `include_guest_circles BOOLEAN NULL DEFAULT true`, `show_place BOOLEAN NULL DEFAULT false`, `show_details BOOLEAN NULL DEFAULT false`, `link_version INT NULL DEFAULT 0`, `link_active BOOLEAN NULL DEFAULT false`.
- `look_rev BIGINT NULL DEFAULT 0`: the look-in cache's revision (§ 12).

Nullable so both delete scrubs can wipe them (`app/api/session/[code]/route.ts:274-280` and the account-deletion path name every column; a tombstone keeps `id`, `deleted_at` and `public_id`). 🔒 Every read treats NULL as closed or off.

`ADD COLUMN … DEFAULT` fills existing rows: that is the go-live opening of old moments (ruled), dark until the flag flips (§ 11). The migration NULLs the new columns again on tombstones (`deleted_at IS NOT NULL`), keeping the scrub contract. **Except guest-hosted ones:**
- The migration runs `UPDATE sessions SET visibility = 'members' WHERE host_user_id IS NULL AND deleted_at IS NULL AND host_name IS DISTINCT FROM '[deleted]'`. A host who deleted their account is stamped `'[deleted]'` (`lib/accountDelete.ts:402`) and keeps its stored setting. `[deleted]` is a reserved display name (`packages/core/src/displayName.ts:10`), but the migration's precheck counts guest-hosted rows named `[deleted]` before trusting it. This one-off statement is the ONLY place the display string is read; at runtime nothing branches on it.
- **Promotion** (`lib/session.ts:646`) of a moment without a signed-in host writes `members` from then on.
- An old instance promoting during the rolling deploy still writes the default, so the go-live runbook repeats the UPDATE.
- 🔒 **At runtime, `host_user_id IS NULL` freezes the setting:** the settings PATCH refuses any change that opens it wider (narrowing, down to `members`, stays allowed, deny-direction), for host and cohosts alike, and such a moment never gets a link. A guest-hosted moment therefore stays closed, and a host-deleted one keeps what it had.

`prisma/session-record-checks.json` is regenerated for the new CHECKs; the triggers are pinned in a suite (migrate diff can't see them).

**`moment_privacy`** (new): `session_id INT` (FK `sessions`, RESTRICT: rows survive a soft delete like `feed_items`), `user_id INT` (FK `users`, CASCADE), `only_inside BOOLEAN NOT NULL`, PK `(session_id, user_id)`. Keyed by the session's id, not its code: member rows are deleted with the moment (`app/api/session/[code]/route.ts:269`) and are keyed by a code that can be recycled. A kick keeps the row and a rejoin doesn't clear it. It is the third RESTRICT child of `sessions`, so the hard-delete runbook (`docs/dev/session-deletion.md`) clears it first.

**Guests without an account** exist only on the web and live only in the cache (their ratings never reach Postgres: `ratings_session_rater_known`, release B migration line 80). Their choice: `s:{CODE}:shown`, a set of guest identities shown to lookers, SADDed only when a join MINTS the identity (from step 1 on, while the flag is still off; no later path re-shows a guest who hid), SREMed by their switch. A guest missing from it is counted only, so a lost key hides (fails closed). After a full eviction guests don't exist at all. Guests already in a live moment at go-live are seeded into `shown` by the runbook, as a fenced write inside the session mutation contract per moment (ruled: same default as everyone).

Meta mirrors `visibility`, `include_guest_circles`, `show_place`, `show_details` for Moment Setup (`metaFromRecord`); the look-in never reads them from the cache. `link_version` is not mirrored.

## 6. Who may look in (one module, two halves)

`lib/momentAudience.ts`, one module for the look-in, the feed's `momentId` and `hostName`, and the profile's open rows. Behind the flag (§ 11). It has TWO halves, because "named to V" (§ 7) includes the post gate, which is TypeScript (`canViewPosts`, `lib/profileVisibility.ts:148`, with FoF via `viewerFofAuthorSet`), and copying it into SQL would be the drift `lib/outsideView.ts` warns against:
- **SQL** finds the candidates: the moment's row, membership, bans, block pairs, the host's and the members' follow edges to V, `only_inside`, Show Moments.
- **TypeScript** then runs the existing bulk post gate (`batchLoadVisibilities` + `canViewPosts` + `viewerFofAuthorSet`) over the candidate bridges and the host. Candidates are capped per request, in a fixed order (by user id), so the answer doesn't flicker between polls. Past the cap it fails closed: no admission through the remaining candidates, and a host beyond it is not named.

Every caller goes through the module's one entry point; a suite pins its answers against the single-profile gate.

The viewer V may look into moment M when:
- M has a live row (`deleted_at IS NULL`) and `visibility` is not NULL.
- V is not a current member (members get `member: true`, § 4).
- V is not banned (`session_bans`), and there is no block pair between V and the host.
- And the audience admits V:

| `visibility` | Admitted | With `include_guest_circles` also |
|---|---|---|
| `members` | nobody | nobody |
| `friends` | mutual follow with the host | mutual follow with a **bridging** member |
| `followers` | V follows the host | V follows a bridging member |
| `verre` | every signed-in user | (switch hidden) |

🔒 **A bridging member is one who would be NAMED to V** (§ 7): current, not kicked, not `only_inside`, no block pair with V either way (the `bridgeUnblocked` rule, `docs/dev/block.md`), their own settings admitting V. Otherwise admission itself would tell V that a hidden friend is in the moment.

"The host" = `sessions.host_user_id`: a cohost who picks Your Friends opens the moment to the HOST's friends, and the app labels it "Host's Friends" for cohosts. A hostless moment (the host deleted their account) has no host circle. Kicked viewers are outsiders like anyone.

**The link** skips the audience: any signed-in app user with a valid link (`link_active`, the version matches, the secret configured, a signed-in host) may look in, kicked viewers included. 🔒 An unknown, reset or turned-off link, a deleted moment, a banned viewer and a block pair with the host all get the SAME answer ("This link doesn't work", 404). The same goes for every refusal by `public_id`: one 404 for unknown, not admitted, banned, blocked and deleted.

## 7. What a look-in shows

**Read** from the record for everything the record holds, plus a dedicated cache reader for the guests without an account. It never opens or rebuilds the moment ("list reads never rebuild", `lib/CLAUDE.md`).
- **The guest reader** runs AFTER the line-up is decided: `shown` ∩ the identities hash, minus bans and kicked, capped per request (a code holder can flood a roster, R8 in `app/api/rate-limits.md`), then one MGET of `s:{CODE}:r:{guest}:{wineId}` over ONLY the ids that survive `outsideViewSql`, keyed by position in the output. Reading the full cached line-up would hand out scores for a hidden line-up, or its size. Never a SCAN (`buildRatingsView` scans the keyspace and force-rebuilds, `lib/sessionState.ts:316-320`).
- **Staleness:** ratings are written in the same transaction as the room (`rate/route.ts`), but the line-up mirror is best-effort and repaired only by the next line-up write (`lib/sessionRoute.ts:163`). So a failed hide after a reveal can leave a bottle revealed in a look-in until then (§ 13).

**The moment:**
- **Name:** a nameless old moment reads as its host's name (`lib/profileLists.ts:417`) only when the host is named to V, else "Untitled Moment".
- **Cover:** dropped if it matches the old code-bearing key; the predicate of `lib/profileTiles.ts:119` is shared.
- **Date** and the category. The moment's time zone (a coarse location) only with `show_place`; without it the app shows the time in the viewer's zone.
- **The address** only with `show_place`; **the description and web link** only with `show_details`.
- **"Hosted by <name>"** only when the host is named to V; otherwise the line is left out. The naming rule is for outsiders: a member of the moment always gets the host's name, as today.

**The line-up:** `outsideViewSql` (`lib/outsideView.ts`) with a **NULL viewer**: as coded, a viewer who added a bottle bypasses the blind rule (`:66-67`), and an outsider gets no bypass. A blind bottle not yet revealed and the moment not over → a blind row; a hidden line-up before its reveal time → left out. 🔒 **No look-in row carries a wine id in its fields**, only its position: a blind bottle's id fetches old photos (§ 10), and any id joins straight to a hidden person's Impressions list (`lib/profileLists.ts:201`). ⚠️ A current wine photo's URL still contains the id (`wines/<wineId>_<random8>`, `lib/session.ts:547`, the same shape the rekey produces). So the guarantee is not "the id never travels": it is that **no surface about a hidden person ever carries a moment's wine id or that moment's wine photo** (§ 9.4). Blind rows carry no photo at all. Opaque wine-photo keys for new uploads (the `lib/imageKeys.ts` pattern) are a cheap belt for the step-1 plan to weigh against the rekey script's shape classifier. "Brought by" shows only with `show_provenance` on, on a non-blind row, for a bringer who is named to V.

**People.** The total is the same for every viewer: everyone in the room (current non-kicked members + guests in the identities hash). A person is **named** to V only when ALL hold:
- a current member, not kicked;
- no block pair with V, either way;
- not `only_inside`;
- **Show Moments** on;
- the **post gate** admits V (`canViewPosts`, `lib/profileVisibility.ts:148`): their post of this moment would show their attendance anyway.

Named = name, photo (avatar gate), scores, notes, aromas, structure, rating photos. Everyone else counts in "N more tasters", block pairs included: counted, never subtracted per viewer, so no count differs by viewer (`docs/dev/block.md` § Counts).
- **Kick-keep raters:** excluded entirely, as the room excludes them (`docs/dev/kick-ban.md`).
- **Deleted accounts and raters without a member row:** counted, never named.
- **A guest without an account:** named with scores when in `shown`, else counted.
- **Averages:** every counted rater's score (ruled). For guests without an account, the reader also MGETs the scores of guests not in `shown` (same cap, same surviving ids), and uses them only inside the averages.
- **A host without an account** has no settings, so outsiders never see their name: the "Hosted by" line is left out, in the look-in and on feed posts.
- **No usernames** (moment content); a named person taps through to their profile.

## 8. Entry points (app)

- **Feed.** A moment post gains `momentId` only when V may look in, and its `hostName` only when the host is named to V or V is a member. The feed page is a Prisma `findMany` (`app/api/feed/route.ts`), so both come from ONE batch query per page over the page's session ids. A member enters the moment as today; anyone else opens the look-in. The `hostName` gate is a stricter rule and is not behind the flag. It applies wherever a moment post is built: `/api/feed` (app feed, `?user=`, `?item=`, and the web feed, whose card then shows no host line, `components/social/SessionFeedCard.tsx:98`) and the web profile loader (`lib/profileLoad.ts:338`, select at `:227`).
- **Someone's profile, Moments list** (`lib/profileLists.ts:398`). Shared rows as today (with `code`: the viewer is a member), plus **open rows**. 🔒 An open row appears only where the profile OWNER is named to V in that moment (§ 7: Show Moments alone, `gate.sees.moments` at `:402`, is weaker). Otherwise a host the look-in hides would still be listed one tap away with a host chip (`role`, `:437`). The row carries no code, `momentId`, and no address or details unless the switches allow. 🔒 On open rows the facets (`people`, `hosts`, `roles`, `lib/momentFacets.ts`) match only people named to V, and the text search `q` matches the host's name (`lib/momentFacets.ts:235-236`) only when the host is named to V. Otherwise filtering by "Alice was there", or searching for Alice's name, is an attendance oracle. Applied before paging and counts. `otherCount` counts the rest. The header's Moments count (`lib/profileHeader.ts:92-98`) and the Moments tile cover (`lib/profileTiles.ts:112-119`) follow the same rule.
- **The link.** A Moment Setup row "Look-In Link": status, Share, Turn Off, Reset (host and cohosts; not shown for a moment without a signed-in host). The ban confirmation offers "Also reset the look-in link" whenever a link is active: we can't tell who saw a forwarded link, and recording who opened it would mean tracking lookers. Every link write (Share, Turn Off, Reset) runs `isSameOrigin`, a rate limit, and re-decides the caller's power from a fresh grant under the session mutation contract (`ctx.caller`). The link is a universal link (associated domains + the app's link router: a new dev build); without the app the path serves the static page (no moment data, `noindex`).
- **Join** on a look-in opens code entry with the scanner (`apps/mobile/src/lib/joinByCode.ts`, `useVerreScanner` in `apps/mobile/src/components/people/scan.tsx`).
- **Routing:** the look-in screen is mirrored per tab stack like the moment routes (`apps/mobile/src/lib/sessionStack.ts`). A looker who joins switches to the moment.

## 9. "Only Inside This Moment"

Stored in `moment_privacy` (signed-in) or `s:{CODE}:shown` (guests without an account, § 5). Signed-in people set it in the app, from the moment's settings hub (`apps/mobile/src/app/(tabs)/moments/session/[code]/settings/index.tsx` and its mirrors) and from the moment post's ⋯ menu (same flag). Guests without an account set it on the web, in the guest menu (`components/session/SessionAnonMenu.tsx`).

**Effects for a signed-in person:**
1. **Look-in:** counted only; they bridge no circle (§ 6).
2. **Their post of the moment:** visible only to current members and themselves, and only to themselves once the moment is deleted. The post gate stays per author (`canViewPosts` is a TypeScript predicate); the per-post part is a SQL exclusion applied **before paging**, or the cursor gives away a hidden post's time. Shape: a batch pre-query of the (author, session) pairs hidden from V, then a Prisma `NOT` clause on the page query.
3. **Their Moments list:** the moment leaves open rows; the header count and the tile cover follow (§ 8).
4. **Their impressions** on someone else's view of their list:
   - no `momentName` (`lib/profileLists.ts:182`, `:197`) and no match on the moment's name in the list search (`:166`);
   - no `postId` (`:130`): the viewer can't open that post, and the id alone says the row came from a moment;
   - 🔒 no `wineId` (`:201`; the row keys on the rating's id): a wine row belongs to one moment, and another member's list or feed post carries the same id WITH the moment's name (`:182`, `lib/sessionFeedWines.ts:104`), an exact join;
   - no fallback to the moment's wine photo (`:180`; the rating's own photo only): the line-up shows that same URL. The same holds for the Impressions tile pool, which falls back to `w.image_url` (`lib/profileTiles.ts:102`).

   The row opens as a plain impression: a read by the rating's id, through the same post gate as the list, answering only what the row already shows.
5. **Their cravings** from that moment, on someone else's view of their list, get the same strip. Others' cravings rows carry no moment NAME (`:284`), but they do carry `wineId`, `postId` and the moment's wine photo (`:337-338`); another member's post carries that id WITH the moment's name (`lib/sessionFeedWines.ts:133`). So: no `wineId` (key on the bookmark's id) and no `postId`. The photo falls back to the taster's own rating photo only when the post gate admits the viewer (`gate.sees.posts`). Cravings and posts are admitted separately (`lib/profileLists.ts:271`, `:275`), so otherwise the row gets no photo at all. The Cravings tile pool follows the same rule, automatic (`lib/profileTiles.ts:124`) and pinned alike. A pinned tile photo that is such a moment's wine photo is not shown to non-members, and the tile falls back to automatic.
6. **Likes** on a post that becomes Only Inside: a non-member's existing like comes off through the open DELETE (`app/api/CLAUDE.md` § Status code rules), and no count reaches them; a new like is a 404, as for any hidden post.

**Read paths to change:** every read pinned by `scripts/check-post-reads.mjs`, plus the readers it can't see (its own header, lines 20-27): `lib/profileTiles.ts:102` (the Impressions pool), `:112-119` (the Moments pool) and the Cravings pool, `lib/profileHeader.ts:92-98`, `lib/momentFacets.ts` (`people`, `hosts`, `q`), and the impressions and cravings loaders. All go into the leak matrix (`scripts/tests/you-profile-integration.mts` § 11) and a new section.

**Writes:** two routes, both behind the flag (§ 11), both running `isSameOrigin` and a rate limit.
- **The moment route** serves the settings hub and the web guest menu (`sessionFetch`, `X-Verre-Web`). It checks membership from the record; for guests it does a fenced SADD / SREM inside the session mutation contract.
- **The post route** serves the ⋯ menu. It is keyed by the post (`feed_items.id`) and authorised by authorship alone, so it still works after the moment is deleted, when member rows and the code are gone (`app/api/session/[code]/route.ts:269`, `:276`). It writes the same `moment_privacy` row.

Hiding is deny-direction (it may precede COMMIT), showing follows it.

## 10. The code never leaks

- No `code` in any look-in payload, open row, feed field or link answer (§ 4). The look-in builders are NEW allow-list builders, never `metaToWire` / `buildMetaView` (it carries `code`, `lib/sessionState.ts:190`).
- **A canary section** in the suite scans every response from a non-host route for the fixture moment's code AND its link token, like § 18 (public ids) and § 21 h (usernames).
- **Old images:** covers `sessions/<CODE>_<ts>` and wine photos `wines/<wineId>.<ext>` (`scripts/rekey-session-images.mts` header). `--apply` copies them; only `--reclaim` deletes the old objects (`:53`). 🔒 **Go-live gate:** `--apply`, then `--reclaim`, then a dry run reporting zero legacy keys and zero skipped, all on the live server, before the flag flips.
- **A leak that exists today, closed in step 1:** the feed sends a blind bottle's id to non-members (`lib/sessionFeedWines.ts:104`), and profile lists send `wineId` on blind rows too (`lib/profileLists.ts:201`). With an old photo key that fetches the label before the reveal. Blind rows on every outside surface lose the id. That changes a shipped contract: the web feed card keys rows on `w.id` (`components/social/SessionFeedCard.tsx:75`) and the app reads `wineId` on impressions rows. The step-1 plan lists every consumer, names the replacement key (the position), and checks that installed app builds tolerate a missing id.

## 11. Going live

- **A server flag, `MOMENT_LOOKIN_ENABLED`** (the `lib/catalogGate.ts` pattern). While it's off, every look-in read, open row, `momentId`, link route AND every Only Inside write answers as if it didn't exist, and the app hides the switches. Steps 1–3 merge dark (merge = deploy). Readers ship before writers: no Only Inside choice can be saved while an instance without the per-post exclusion still serves posts.
- 🔒 **Rollback floor:** once the flag is on and someone has saved Only Inside, no deploy may go below step 3 (it would serve those posts to everyone). Roll forward only, as `docs/dev/profile-visibility.md` already rules for account privacy; recorded in `docs/dev/deployment.md`.
- **Flip only after** steps 1–3 are deployed, the app build with the switches is out, and the go-live runbook has run:
  - the image gate (§ 10);
  - the guest-hosted UPDATE again (§ 5);
  - the `shown` seed (§ 5);
  - `MOMENT_LINK_SECRET` checked on every instance.
- **At the flip** every old moment with a signed-in host opens to the host's friends + guests' friends, place and details off (ruled). Its people still decide what shows of them. Signed-in people who use only the web can't change any of it (ruled app-only, § 13).

## 12. Live, limits, load

- **Polling:** while the look-in screen is focused, at the moment screen's cadence; pushed screens own their poll.
- **Limits:** per user with an IP backstop (`checkRates`, the People-lists pattern) on the look-in read and the link check; per user on the link management and the Only Inside writes. Numbers are set in the step-1 plan (one viewer polling one moment ≈ 12/min).
- **Load:** with a NULL viewer, the moment's SOURCE data (the line-up after `outsideViewSql`, the raw scores, the guest MGET) is the same for every outsider. Plan: a few-second shared cache of that source data. Measure first (EXPLAIN on a seeded moment with 200 tasters and 1,000 lookers).
- 🔒 **The cache holds no privacy decision.** Every control is read FRESH per request and applied on top of the cached source: Moment Visibility and its switches, `only_inside`, `shown`, bans and kicks, the per-person gates. They are cheap primary-key reads.
- 🔒 **A durable revision fences the cache.** `sessions.look_rev BIGINT NULL DEFAULT 0` (nullable and scrubbed like the rest, § 5) is incremented IN THE SAME TRANSACTION as every write that can tighten a cached decision. Every one of these writers already runs the session mutation contract, which holds the row `FOR UPDATE`, so the increment adds no new lock:
  - line-up writes (add, edit, delete, reveal, hide, reorder);
  - kicks and bans;
  - the settings that `outsideViewSql` reads (`lib/outsideView.ts:43`, `:68`): blind, Blind for Everyone, Hide Line-up and its minutes, the dates, deletion.

  The look-in already reads the `sessions` row fresh on every request (for the controls above). It takes `look_rev` from that same read and uses only the cache entry stored under it. A fill reads `look_rev` and the source data in one snapshot, then stores under that revision. A committed tightening write therefore makes every older entry unreachable at its COMMIT: no window, and no post-COMMIT step that a crash could skip.

  Rating writes don't bump it (a score changes no privacy decision). Fresh scores come from the cache's few-second TTL. Time only ever loosens these decisions (a moment ending reveals, a reveal time passing un-hides), so a cached entry is at worst stricter than the truth for its few seconds.

## 13. Residuals (named)

- **Averages** include hidden scores: with 3 tasters and 2 visible, the third can be worked out. Ruled.
- **Only Inside impressions** still show with bottle and date, so someone who also looks into the moment, or sees another member's post of it, can match them. Ruled. Without wine ids, post ids and the moment's photo (§ 9, also on the tile), it is a match by name, vintage and date, never an exact join.
- **A row without a post id and a wine id** reads as "from a hidden moment" (within the ruling: the impression shows, the moment doesn't).
- **Show Moments off** keeps you out of look-ins and your Moments list, but your impressions (where your post audience can see them) still name their moment, as they do today (pre-existing; Show Moments was ruled to cover the Moments tile and list).
- **The link's URL** can sit in the platform proxy's access logs, which the app can't redact.
- **Show My Locations** doesn't hide a named member at a moment whose host turned on Show the Place (ruled 2026-11-11: that setting covers check-in places only).
- **A removed or kicked cohost** keeps the link they saw until the host resets it (ruled: no automatic offer).
- **The host's circle tells:** with guests' circles off, being admitted while the host is hidden tells V the host is one of their friends or followers.
- **"Include Followers of Guests"** reaches anyone who follows any named member, and following needs no approval.
- **A forwarded link** works for any app user until it's reset or turned off.
- **Going live** opens old moments, 4-character ones included. Those codes can be swept (300 an hour per address, R5, `docs/dev/session-codes.md`), and a named, open moment makes one worth finding.
- **Signed-in people who use only the web** can't change Moment Visibility or hide themselves (guests without an account can, on the web).
- **"N more tasters"** says how many are hidden from you (by design).
- **The line-up** can trail the room until the next line-up write (§ 7).
- **Guests without an account** are counted only after an eviction (§ 5).

## 14. Open questions (settled as built: see the status line)

1. **Tier label:** "Everyone on Verre" here vs "Verre Users" in Account Visibility.
2. **The name of the description-and-link switch.**

(Settled in review: an Only Inside impression opens as a plain impression, § 9; guests at go-live are seeded, § 5.)

## 15. Steps

Each step: plan → Claude reviewers → Codex → device pass.

1. **Server, dark behind the flag:**
   - the migration (with the guest-hosted UPDATE), `public_id`, `moment_privacy`, the link derivation (`link_version` + `link_active`) and its host-and-cohost read, `MOMENT_LINK_SECRET` failing closed, `lib/momentAudience.ts`;
   - the look-in read with the guest reader, limits and the shared cache;
   - open rows, facets, header count and tile on profiles; the feed's `momentId`, and the `hostName` gate (live);
   - the member-only by-moment read; the settings PATCH fields; promotion stays closed; both delete scrubs;
   - blind rows without ids (live); `shown` SADD at join; the canary section.
2. **App:** Moment Setup (Moment Visibility + the guests' switch, Show the Place, the details switch, the Look-In Link row), the ban flow's reset offer, the look-in screen with tab mirrors and polling, the entry points, Join with code entry, the universal link (new dev build).
3. **Only Inside This Moment:** the per-post exclusion across every post read (census + non-census), the impressions and cravings strip (origin, post id, wine id, photo fallback, the Impressions and Cravings tile pools), the read by rating id, the post-keyed write for the ⋯ menu, the likes rule, the switch in the app's settings hub and the post ⋯ menu, the guest switch in the web's guest menu.

**Go live:** the runbook (§ 11), then the flag.

## 16. Docs to update

README (API table), `app/api/rate-limits.md`, `docs/dev/profile-visibility.md`, `docs/dev/social-feed.md`, `docs/dev/session-deletion.md` (the scrub columns, and `moment_privacy` in the hard-delete runbook), `docs/dev/block.md` (the look-in row), `docs/dev/session-features.md` (the privacy review found it still says `showProvenance` has no Postgres mirror; the column exists), `docs/dev/deployment.md` (`MOMENT_LINK_SECRET`, `MOMENT_LOOKIN_ENABLED`), `apps/mobile/CLAUDE.md`, the root CLAUDE.md pointer once shipped. New user-facing routes join § 18 of `scripts/tests/you-profile-integration.mts`.

## 17. Review history

- **Round 1** (2026-11-15, three Claude reviewers, Fable 5.2 medium):
  - **Privacy:** 3 P1 (hidden members bridged admission; wine ids joined look-ins to hidden people's lists; the host's name already shown on feed posts), 5 P2, P3s.
  - **Plan solidity:** 2 P1 (`only_inside` on member rows died with a deleted moment; step 1 opened old moments with no controls), 7 P2, P3s.
  - **Security:** 1 P1 (the same bridging hole), 7 P2 (among them the hash-only link couldn't be shown twice, a code-returning member path, the guest SCAN per poll, and the blind wine id the feed sends today), P3s.
  - All applied above, with the second interview's rulings.
- **Round 2** (same reviewers, rechecking their own findings): round 1 confirmed fixed except a few partials. New findings:
  - **Security, P1:** Turn Off then re-share revived old links (NULL lost the counter) → monotonic version + `link_active`.
  - **Security, P2:** the secret must fail closed; the guest reader must run after the redaction.
  - **Privacy, P2:** `hostName` also on the web profile's posts; guest-hosted moments reopened by the link; web guests named with no switch (ruled: the switch goes on the web).
  - **Plan, P2:** the backfill opened already-promoted guest-hosted moments → migration UPDATE.
  - P3s: time zone, `postId` and the photo join on Only Inside impressions, likes, blind-id consumers, the hard-delete runbook, the by-moment read for kick-keep, the fenced guest seed.
  - All applied above.
- **Round 3** (one convergence reviewer, all three lenses):
  - **P1:** Only Inside impressions still joined exactly through `wineId` (and the Impressions tile's photo fallback) → both stripped.
  - **P2:** "named to V" needs the TypeScript post gate, so the audience rule is SQL candidates + the bulk TypeScript gate, pinned by a parity suite.
  - **P2:** profile open rows used a weaker rule than "named" → the owner must be named.
  - **P2:** a cohost could open a guest-hosted moment → `host_user_id IS NULL` freezes it (narrowing only), and `[deleted]` is read only by the one-off migration.
  - P3s: the static page's referrer, tombstones stamped by the column defaults, averages vs the guest reader, a guest host's name, SADD only at mint, the member-only read's wording.
  - All applied above. **Recheck: CONVERGED** (P3s on the cap, opening a stripped row, the absence signal and stale labels, all applied).
- **Codex r1** (xhigh, fresh view):
  - **P1:** cravings kept the exact joins → same strip.
  - **P1:** the Moments search `q` matched a hidden host's name → gated.
  - **P1:** current wine-photo URLs embed the wine id → the guarantee restated (no hidden-person surface carries the moment's wine id or photo), plus the opaque-key belt.
  - **P2:** the ⋯ switch couldn't write after a deletion → a post-keyed, author-authorised route.
  - **P2:** Only Inside writes weren't behind the flag → flagged, readers before writers, rollback floor.
  - **P2:** the shared cache had no privacy-invalidation contract → fresh controls over cached source, revision-fenced fills.
  - All applied above.
- **Codex r4** (resumed): "Fixed. No material findings." One P3 (a `NOT NULL` left in § 12), applied.
- **Codex r3** (resumed): the Cravings photo fixed. **P2 (partial):** the double bump left a readable middle revision and a crash window → the revision moved into Postgres (`sessions.look_rev`), incremented in the tightening write's own transaction and read with the controls. Applied.
- **Codex r2** (resumed): five fixed. **P2 (partial):** settings that change the redaction didn't bump the revision → added, with the double bump around COMMIT. **P2 (new):** the Cravings photo fallback could show a rating photo the post gate hides → only when `gate.sees.posts`, else no photo; pinned tile photos too. Both applied.
