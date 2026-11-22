# Verre — Wine Tasting OS

Mobile-first shared wine tasting sessions with a live bottle list, per-person radar ratings, bottle photos, and print-ready export. Runs on Deploio with Redis + Postgres + S3-compatible object storage.

## What it does

- Create or join a tasting with a short shareable code
- Keep one shared bottle lineup across the whole table
- Rate privately on each phone with stars, a structure radar (sweetness, acidity, smell, taste, funk, tannin, body, finish — 0–5 intensities; + bubbles for sparkling), and notes
- Sign up for an account to keep your history, or stay anonymous
- Compare participants or overlay profiles per bottle
- Add bottles from a shared wine catalogue: find the producer, then the wine, then its year (or add a missing year, or a new wine, when signed in; a guest picks from what exists). A non-vintage release has its own NV checkbox beside the year
- Attach bottle photos for the session list, detail view, and export
- Edit wines after creation and reorder the lineup during the tasting
- Share a join link or QR code for fast session entry
- Guest (anonymous) sessions last 48 hours; a session anyone signed in has touched is kept for good
- Save wines you liked: Saved shows each wine once, with the vintages you saved and your ratings of it. A save made during a blind tasting shows up after its reveal
- Earn badges and XP across all your tastings
- Blind tasting mode for hosts (pro)
- Co-host roles to delegate wine management; Provider role for someone bringing their own bottles without full host powers
- Hide the wine lineup before the tasting starts
- Hosts can permanently delete a session and its data; saved wines stay saved
- Hosts can kick or ban participants from a tasting (with optional wine removal); banned users can't rejoin
- Social feed: log standalone check-ins (with photo, location, tagged friends), follow other users, like and discover what your tasting network is drinking
- Public profiles at `/u/<publicId>` showing recent check-ins and stats
- Usernames: a unique `@name` to find and recognise people (chosen at sign-up; existing accounts choose at their next login, change it in Edit Profile / account settings), `/@name` profile links, search by name or username; a renamed or deleted name is held for 14 days
- Optional profile pictures (round-mask cropper, EXIF/GPS stripped before upload)
- Profile visibility tiers (public / Verre users / followers / mutual follows) with optional friends-of-friends extension, plus (in the app) who sees your check-ins (down to Only Me) and whether others see your Cravings, Moments and check-in places
- Mute (quietly hide someone's content from your feed) and Block (full break — bidirectional invisibility outside shared sessions, render-only inside)
- People in the app: anyone's friends, followers and following (with "only people you know"), Add Friends with your own QR code, people you tasted with, search, a profile link to share, and a scanner for Verre profile and moment codes; tapping someone inside a moment shows the same short preview (follow, or unblock someone you blocked)
- Attributions page (`/legal/attributions` on web, You → About in the app) naming the sources and licences behind the wine catalog — a licence obligation, readable without an account

Optional label scan:
- Bottle photos always work without AI
- Label reading is optional and user-provided
- On this branch, a participant can store their own `OpenAI` or `Claude` API key locally on their device and use it to prefill the catalogue search (producer, wine, year, type)
- Keys are not stored in Redis or sent through the Verre backend on this branch

## Architecture

```
Browser ──→ Next.js 16 (Node 24) ──→ Redis     (live session state, 48h+ TTL)
                                  ─→ Postgres  (accounts, history, bookmarks)
                                  ─→ S3        (bottle photos)
```

The app is intentionally simple:
- one Next.js server (App Router, server components + API routes)
- React 19 + TanStack Query frontend in `app/` and `components/`
- one Redis namespace per tasting session (`s:{CODE}:*`); accounts in Postgres

Detailed architecture, API surface, and authorization rules in `CLAUDE.md`.

## Deploy to Deploio

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "init"
gh repo create verre --public --source=. --push
```

### 2. Create KVS, Postgres, and S3 bucket

```bash
nctl create kvs verre
nctl get kvs verre                  # → note the FQDN
nctl get kvs verre --print-token    # → note the password
```

You'll also need a Postgres database and an S3-compatible bucket for bottle photos. Note their connection strings and credentials.

### 3. Create app

```bash
nctl create application verre \
  --git-url=https://github.com/YOURUSER/verre \
  --git-revision=main \
  --dockerfile

nctl update app verre \
  --env='REDIS_URL=rediss://:{PASSWORD}@{FQDN}'
```

Set `REDIS_URL`, `DATABASE_URL`, `NEXTAUTH_SECRET`, and the `S3_*` env vars (see `CLAUDE.md` for the full list).

Or via Cockpit:
1. New Application → your repo → toggle **Dockerfile Build**
2. Set the env vars listed above
3. Port: `8080`
4. Deploy

### 4. Add custom domain (optional)

```bash
# Cloudflare DNS:
# CNAME  tasting  →  your-app.<deploio-org-id>.deploio.app  (DNS only, grey cloud)
# TXT    _deploio.tasting  →  deploio-site-verification=...
# SSL/TLS mode: Full
```

## Local development

```bash
# Redis
docker run -d -p 6379:6379 redis:7-alpine

# S3 (RustFS — S3-compatible, Apache-2.0; the MinIO community image was
# archived in April 2026 and is no longer maintained. Pinned tag on purpose.)
docker run -d --name verre-s3 \
  -p 9000:9000 -p 9001:9001 \
  -e RUSTFS_ACCESS_KEY=minioadmin -e RUSTFS_SECRET_KEY=minioadmin \
  -v verre-s3-data:/data -v verre-s3-logs:/logs \
  rustfs/rustfs:1.0.4

# First-time bucket creation + public-read policy (so <img src> from
# the browser can fetch uploaded objects):
docker run --rm --network host \
  -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin \
  amazon/aws-cli:latest --endpoint-url http://localhost:9000 \
  s3 mb s3://verre-local
docker run --rm --network host \
  -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin \
  amazon/aws-cli:latest --endpoint-url http://localhost:9000 \
  s3api put-bucket-policy --bucket verre-local --policy '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::verre-local/*"]}]}'

# Postgres: run locally (docker) or point DATABASE_URL at a dev DB.
# Then apply migrations to set up the schema:
npx prisma migrate deploy

# Start app
npm install
npx prisma generate
npm run dev
# → http://localhost:3000
```

Local `.env` for the bucket (the access-key values are arbitrary local defaults; `minioadmin` is kept so existing `.env` files keep working):
```
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=verre-local
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=us-east-1
```

To test from a phone on the LAN, replace `localhost:9000` with your host's LAN IP (e.g. `http://192.168.1.42:9000`) in BOTH `S3_ENDPOINT` and the `<img src>` it produces — the upload flow stores the endpoint as a literal prefix in `users.image_url`. Existing rows uploaded under one address won't resolve from another.

Open `http://localhost:3000`, create a session, and join from a second device if you want to test the shared flow.

### Native iOS app (apps/mobile)

The Expo (React Native) app lives in `apps/mobile` (npm workspace). It talks to the same backend over `/api/*` + Better Auth (`/api/auth/native`). Requires macOS + Xcode for the native build:

```bash
cd apps/mobile
cp .env.example .env.local  # then fill in (gitignored) — see below
npx expo run:ios            # builds the dev client, opens the iOS Simulator
# physical device (backend on your Mac's LAN IP):
EXPO_PUBLIC_API_URL=http://192.168.1.42:3000 npx expo run:ios --device
```

The iOS Xcode project is checked in at `apps/mobile/ios`. To deploy to a physical iPhone from Xcode:

```bash
cd apps/mobile
npm install
cd ios
pod install
open Verre.xcworkspace
```

In Xcode, select the `Verre` scheme, choose your connected iPhone as the run target, set your Apple Team under **Signing & Capabilities** if needed, then press Run. Use the `.xcworkspace`, not the `.xcodeproj`, because CocoaPods integration is workspace-based. `ios/` is checked in and authoritative; `Pods/` is intentionally not, so run `pod install` after a fresh clone or dependency change.

To archive and upload a TestFlight build:

```bash
cd apps/mobile
npm install
cd ios
pod install
open Verre.xcworkspace
```

Then in Xcode select a generic iOS device or **Any iOS Device**, choose **Product → Archive**, and upload the archive from Organizer. Before archiving, set production values in `apps/mobile/.env.local` or your build environment, especially `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WEB_URL`; `EXPO_PUBLIC_*` values are baked into the native bundle at build time.

If native dependencies change and Xcode/Pods get out of sync, refresh carefully from the Expo config:

```bash
cd apps/mobile
npx expo prebuild --platform ios
cd ios
pod install
```

`expo run:ios` and `expo prebuild` can rewrite tracked files under `apps/mobile/ios`; review those diffs before committing. Do not use `expo prebuild --clean` casually because it deletes and regenerates the authoritative native project.

**Env vars** (`apps/mobile/.env.local`, gitignored; `EXPO_PUBLIC_*` are inlined into the bundle at build time):

- `EXPO_PUBLIC_API_URL` — backend the app talks to. Simulator defaults to `http://localhost:3000`; a physical device needs the Mac's LAN IP.
- `EXPO_PUBLIC_WEB_URL` — public web origin for shareable links (the `/join/<code>` invite URL). Set to the real domain in prod. If unset, falls back to the API URL so local-deployment links resolve against the same backend.

Day-to-day JS iteration after the first build: `npx expo start`. See `apps/mobile/CLAUDE.md` for toolchain rules (SDK pinning, auth-version lockstep, design tokens).

## API

Authentication: logged-in users carry a NextAuth session cookie; anonymous users carry a per-session `x-vr-anon-token` header. See `CLAUDE.md` for the full authorization rules per endpoint.

Session endpoints (`/api/session/:code/**`) answer **503 + `Retry-After: 1`** while a moment whose cache was lost is being restored from Postgres, or while it is busy — retry; **404** only when the moment is really gone.

**User ids are public ids.** Every user id in a path, query, body or response is a 12-character public id (Crockford base32, letter first, e.g. `K7QM2X9TPB4N`); identities are `u:<publicId>` (anonymous `a:<uuid>` as before). An integer user id is malformed (400) everywhere. Image URLs carry no user id. The web sends `X-Verre-Web` on every `/api/session*` call (a signed-in moment call without it is answered 401 + `X-Vr-Auth: invalid`: an old tab reloads); the app's `X-Verre-Client` is gated on every `/api` call (426 below the floor).

**Auth + account**

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | /api/auth/[...nextauth] | NextAuth sign-in / sign-out |
| POST | /api/auth/register | Create an account: `{name, username, email, password, formToken}` (the username is required). 409 `{error, fields: {email?: 'taken', username?: 'taken'}}` names both conflicts at once. The app signs up through Better Auth (`POST /api/auth/native/sign-up/email`, the same fields): 422 with `code` `EMAIL_TAKEN` / `USERNAME_TAKEN` / `EMAIL_AND_USERNAME_TAKEN`, 400 `INVALID_USERNAME`, and a session in the same call |
| GET | /api/me/profile | Flavour profile + rating stats |
| GET | /api/me/sessions | Sessions this user joined (incl. wine_count, live taster_count, caller's role, category). Per-row `status` (`live`/`upcoming`/`past`) + `pinned` drive the home carousel/counts. No params → 50 most-recently-active (bare array). With `?tense&q&roles&hosts&people&category&from&to&cursor&limit` → server-filtered + keyset-paginated over the whole history (`nextCursor` in the `X-Next-Cursor` header); `tense` splits the lists by date, `q` is accent-insensitive + typo-tolerant over name/host. Sessions the caller is kicked from are omitted |
| POST/DELETE | /api/session/:code/carousel-hidden | Hide / un-hide a moment from the Moments-home highlight carousel (personal view pref; stays in "All moments"). Logged-in only; auto-un-hidden on re-engagement (visit/rate) |
| GET | /api/me/bookmarks | Saved: one row per wine `{key, name, producer, grape, style, colour, sparkling, abv, category, image_url, purchase_url, saved_at, linked, vintages: [{key, vintage, saved_at, session_id, session_code, session_deleted}], ratings: [{id, score, flavors, notes, rated_at, vintage, session_id, session_code, session_deleted}]}`: the vintages you saved (`vintage: null` = any year; `linked: false` = no catalogue link, nothing known of its years) and your ratings of that wine as context. A save whose bottle is still hidden for you (blind, or a hidden line-up) is left out until its reveal; a rating of such a bottle too. `session_code` only for a moment you were in |
| GET | /api/me/ratings | This user's rating history (newest 200). Outside its moment a bottle follows the moment: hidden line-ups left out, blind bottles as `_blind: true` rows (score, date and style stay) |
| GET / POST / PATCH | /api/me/badges | Earned badges, XP, manual recheck, mark-as-seen |
| PATCH | /api/me/account | Edit own name / email / password (pw change revokes other devices; an email change from the app needs `currentPassword`) |
| DELETE | /api/me/account | Delete own account (password re-auth required) |
| GET | /api/me/devices | List own active device sessions, web and native (`ba:<id>`); `isCurrent` marks the caller's own row (web or app); 60/min |
| DELETE | /api/me/devices/:id | Revoke one device; body `{ password }` for any device but your own current one; 30/h |
| DELETE | /api/me/devices | Revoke all other devices, web and native, keeping the caller's own (web or app); body `{ password }`; 10/h |
| POST | /api/me/avatar | Upload / replace own profile picture (body: `{imageData}`); reclaims old S3 |
| DELETE | /api/me/avatar | Remove own profile picture; reclaims S3 |
| POST | /api/me/cover | Upload / replace own profile cover (body: `{imageData}`, returns `{coverPhotoUrl}`); reclaims old S3 |
| DELETE | /api/me/cover | Remove own profile cover; reclaims S3 |
| PATCH | /api/me/profile | Edit own profile without a password: `{name?, bio?, tiles?: {impressions?, moments?, cravings?: url \| null}}` (bio ≤ 200, one paragraph; a tile url must be one of your pickable photos, `null` = back to the latest). Returns only the changed fields (tiles as `{imageUrl, pinned}`) |
| GET | /api/me/profile/photos?pool=impressions\|moments\|cravings | A tile's pickable photos (yours, never an unrevealed blind wine): `{photos: string[] (≤ 60, latest first, the current pin first, your own upload included), pin: string \| null}` |
| POST | /api/me/profile/tiles/:tile | Your own photo on a profile tile (`impressions` / `moments` / `cravings`; body `{imageData}`), pinned at once → `{tiles: {<tile>: {imageUrl, pinned: true}}}`; the tile's previous own upload is reclaimed (as is this one when the PATCH re-pins the tile or sets it to `null`) |
| GET | /api/me/visibility | Read own visibility settings → `{visibility, fofEnabled, checkinVisibility, showCravings, showMoments, showLocations}` (`checkinVisibility`: `null` = Same as Profile, or `public-users` / `public-followers` / `public-mutual` / `only-me`) |
| PATCH | /api/me/visibility | Compare-and-set: `{expected: {…the six as last read}, …changes}` (changes = any non-empty subset of the six). 200 `{ok: true, current}` (also when already applied); 409 `{error, current}` when the stored settings differ from `expected` (nothing written); 400 on a missing `expected`, an unknown key or a bad value. On a 200, `current` can differ from `expected` ⊕ changes in `checkinVisibility` only: a posts choice equal to the account is stored as `null`, and a tier / FoF change narrows a wider posts choice to the tier while FoF is on. 30 actual changes/h |
| GET | /api/me/mutes | Users I've muted (the app's Settings → Privacy → Muted): `{ mutes: [{ id, name, createdAt }] }`, newest first, max 1000; someone who blocked me is left out; 60/min |
| POST | /api/me/mutes/:id | Mute user `:id`; 60/h shared with DELETE |
| DELETE | /api/me/mutes/:id | Unmute user `:id`; idempotent |
| GET | /api/me/blocks | List of users I've blocked (for the settings UI); newest-first, `{blocks: [{id, name, username, createdAt}]}` (no photo: the rows show initials, like mutes) |
| POST | /api/me/blocks/:id | Block user `:id`; 30/h |
| DELETE | /api/me/blocks/:id | Unblock user `:id`; uncapped (recovery path) |

**Sessions**

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/session | Create session (body: `{hostDisplayName, sessionName, dateFrom, blind?, lifespan?, category?, coverPhoto?, dateTo?, timezone?, address?, description?, link?, hideLineup?, hideLineupMinutesBefore?}`; `sessionName` + `dateFrom` **required** for every caller; `coverPhoto` is a base64 data URL, logged-in only; lifespan: logged-in callers always get `unlimited` (a body `lifespan` is ignored), anonymous callers get `48h` and any other value is a 403) → `{code, id, displayName, lifespan, category, coverPhotoUrl?, anonToken?}` |
| POST | /api/session/join | Join session (body: `{code, displayName}`) → `{id, displayName, anonToken?}`; a wrong code pays the wrong-code budget (429 "Too many codes tried" once spent), failed attempts 30/min/IP, guest joins 60 per moment per address per 10 min |
| GET | /api/session/:code/preview | A moment before you join (the app's scan result; auth required, its own budget on every lookup, then the wrong-code budget) → `{code, name, host, hostUserId, hostUsername, dateFrom, dateTo, address, coverPhotoUrl, joined}` (`hostUserId` is the host's public id, null across a block pair; `hostUsername` their `@name`, only beside it: the one username a moment route sends); 404 no such moment, 403 `banned` |
| GET | /api/session/:code | Session meta + participants (participant-gated) |
| GET | /api/session/:code/state | Aggregate poll: `{meta, wines, ratings}` in one response (participant-gated; a section is `null` when it failed server-side) |
| PATCH | /api/session/:code | Role assignment via `action: 'set-role'` (host or cohost, with strict-host required for transitions touching `co_host`) |
| DELETE | /api/session/:code | Delete session permanently (host-only) |
| POST | /api/session/:code/visit | Mark logged-in user as a participant of this session (429 "Too many codes tried" to a non-member whose wrong-code budget is spent, like every moment route) |
| POST | /api/session/:code/leave | Kicked-user self-service. `?cleanup=keep` (default no-op) or `?cleanup=full` (deletes ratings/bookmarks) |
| PATCH | /api/session/:code/settings | Edit session metadata (host-only; pro-gated for blind/showProvenance; `lifespan` is vestigial, no client sends it; `coverPhoto` data URL = replace / `null` = remove, logged-in only) |
| PATCH | /api/session/:code/name | Rename session (host-only) |
| GET | /api/session/:code/visibility | Moment Visibility, read from the record (any participant; 404 while `MOMENT_LOOKIN_ENABLED` is off) → `{visibility, includeGuestCircles, showPlace, showDetails, frozen, canEdit}`, plus `link: {available, active, url, since}` for a signed-in host or cohost. `visibility` is `members` / `friends` / `followers` / `verre`; `frozen` = no signed-in host, the setting can only be narrowed |
| PATCH | /api/session/:code/visibility | Save any of `visibility`, `includeGuestCircles`, `showPlace`, `showDetails` (signed-in host or cohost; not pro-gated; replies with the GET's shape; 403 when a frozen moment would be widened) |
| POST | /api/session/:code/look-in-link | `{action: 'share' \| 'off' \| 'reset'}`: the look-in link (signed-in host or cohost; replies with the GET's shape). `share` on an active link returns the same link; `reset`, and `share` after `off`, make a new one. 403 for a moment without a signed-in host, or while `MOMENT_LINK_SECRET` is unusable |
| PATCH | /api/session/:code/me/name | Anon participant renames themselves in this session (body: `{name}`) → `{name: <possibly-emoji-suffixed>}`. Logged-in users use profile settings instead. 10/min/identity |
| GET | /api/session/:code/bans | List banned identities (host + cohost) |
| POST | /api/session/:code/bans | Kick or ban a participant (body: `{identityId, mode: 'kick'\|'ban', deleteAddedWines?}`). Strict-host required when target is a cohost. A `d:` (deleted account) target accepts `mode: 'kick'` only — it removes their ratings |
| DELETE | /api/session/:code/bans/:identityId | Unban (host + cohost); shares 60/10min rate limit with POST |
| GET | /api/session/:code/bans/preview/:identityId | Preview before kick/ban (host + cohost) |
| GET | /api/session/:code/removed-state | Caller's own removed-state, used by the `?removed=1` bounce screen |

**Wines**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/session/:code/wines | Wine list (participant-gated; redacts blind wines for non-hosts). Each bottle: its own fields (`id`, `name`, `producer`, `vintage` as linked, `colour` / `sparkling` / `abv` as the bottle's snapshot (copied from its wine when linked), `description`, `vinification`, `purchaseUrl`, …) plus `entry`, the catalogue wine it is linked to (`{productId, vintageId, producerId, producer, name, year, category, colour, sparkling, style, abv, grapes, region, country, description, vinification}`, merges followed; `null` when unlinked). A blind row has `entry: null`, `abv: null` and no name or producer; `colour` and `sparkling` stay (the rating wheel needs them) |
| POST | /api/session/:code/wines | Add a bottle (host or provider). Every bottle is a catalogue wine: `{id, productId, vintageId?}` picks one (anyone who may add; `vintageId` null or absent = year unknown), `{id, create}` creates one first (signed in only; `create` is the `/api/catalog/entries` body, minted in the same transaction: a failed add mints nothing; a guest gets one fixed 403 whatever `create` names). Also the bottle's own `{description?, vinification?, purchaseUrl?, position?}`. Its name, producer, year, kind and abv are copied from the wine (typed name / producer / type are ignored). No link → 400. `id` is minted by the client (nanoid, 21 characters): a retry of the same id by the same adder answers `{id, alreadyAdded: true}` without adding a second bottle or entry, someone else's id is a 409. No photo in the body: see `…/image` |
| PATCH | /api/session/:code/wines/:wineId | Edit a bottle (host or provider-of-own-wine): `productId` / `vintageId` or `create` re-links it (the whole snapshot follows the new wine; `productId: null` is a 400: a bottle stays linked), `description` / `vinification` / `purchaseUrl` change only what is sent. The photo has its own call |
| GET | /api/session/:code/catalog/search | The catalogue search from inside the moment, for whoever may add bottles to it (host, cohost, provider; guests included): the same `kind` = `bottle` / `producer` / `product` / `vintages` queries and answers as `/api/catalog/search`. Budget: the signed-in caller's catalogue-search budget (shared with the global route), a guest 60 a minute per address. 404 while the catalogue is switched off |
| PUT/DELETE | /api/session/:code/wines/:wineId/image | Attach / replace (`{image: <data URL>}`) or remove the bottle's photo (host or provider-of-own-wine). 403 in a moment nobody signed in to yet (a guest-only moment keeps no photos) |
| DELETE | /api/session/:code/wines/:wineId | Delete wine (host or provider-of-own-wine); a bottle already gone answers 200 |
| POST | /api/session/:code/wines/reorder | Reorder wines (host-only; body: `{orderedIds}`) |
| POST/DELETE | /api/session/:code/wines/:wineId/reveal | Reveal/hide a single blind wine (host-only) |
| POST | /api/session/:code/wines/reveal-all | Reveal every blind wine (host-only) |
| POST | /api/session/:code/wines/hide-all | Hide every revealed wine (host-only) |
| POST/DELETE | /api/session/:code/wines/:wineId/bookmark | Save / unsave a bottle of the moment (signed-in participant) → `{ok, saved}`. On a bottle you can't see yet ("Wine N") it saves that bottle only: it reads saved, can be unsaved, never changes a save of the same wine made elsewhere, and shows in Saved once that bottle is revealed. A visible bottle not in the catalogue yet → 409. One budget with the post save (300/h). Line-up rows carry `saved` for a signed-in viewer |

**Ratings**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/session/:code/ratings | All ratings, id-keyed (participant-gated) |
| POST | /api/session/:code/rate | Submit own rating (body: `{wineId, score, flavors, notes, aromas?}`). `flavors` is a `{structure-axis: 0–5}` map (keys: sweet, acid, aroma, flavour, funk, tannin, body, finish; + bubbles for sparkling) — keys outside the wine's axis set are rejected. `aromas` is an array of `{a, m, p?}` descriptor selections (`p: true` marks a selection pronounced — the note that led the impression) (a taxonomy node id at any tier — leaf `strawberry`, subfamily `fruity.berry`, family `fruity` — + modifier id or null, from the `@verre/core` taxonomy, max 30) — unknown ids / disallowed modifiers are rejected; **omitting the field preserves stored selections, `[]` clears them**. |
| DELETE | /api/session/:code/rate/:wineId | Reset own rating |

**Social feed** (logged-in)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/feed | Network feed — your follows + tasting buddies (cursor-paginated). `?user=<publicId>` = only that person's posts (the app's profile feed), same item shape and paging; 404 unless you may see their profile (no such user, private to you, or a block either way); 200 with no items when you may see the profile but their Check-Ins Visible To hides the posts. Your mutes don't apply to it. A check-in's place (`venueName`, `city`, `country`) is `null` unless its author shows locations (or it is yours). `&item=<postId>` (requires `user`) = that one post in the same page shape, for opening an old post from a profile list; any miss (another author's post, posts hidden) is the same empty page. A moment post whose line-up is still hidden from you is left out (it comes back once the line-up shows); an unrevealed blind bottle in a post shows no identity. Every row of a moment post's `wines[]` carries `ratingId` (its key); a blind row carries the wine's `id` only when you wrote that rating. |
| POST | /api/checkins | Create a standalone check-in. Body: `{occurrenceId, productId + vintageId? \| create, vinification?, description?, purchaseUrl?, score?, flavors?, aromas?, notes?, venueName?, city?, country?, lat?, lng?, taggedUserIds?, copyFromCheckinId?, copyPhoto?}`. The wine is a catalogue wine, picked or created exactly as on the session wine POST (no link → 400); "had a sip" (`copyFromCheckinId`) takes the SOURCE's wine server-side (a link in the body is then not needed) and its photo unless `copyPhoto: false`. The answer carries `colour`, `sparkling`, `abv` and `entry` (no `type`). `occurrenceId` is minted by the client (nanoid, 21 characters): a retry by the same person answers the existing check-in (200), someone else's id is a 409. No photo in the body (`imageData` is a 400): it attaches afterwards through `PATCH /api/checkins/:id` with `{imageData}`; that first photo, sent alone within 10 minutes of posting, does not count against the check-in budget. `productId`/`vintageId` are validated server-side (`vintageId` requires `productId`); `country` is the venue's. `flavors` is the same `{structure-axis: 0–5}` map as `/rate` (keys outside the wine's axis set are rejected: Bubbles only for a sparkling wine). `aromas` is the same `[{a, m, p?}]` descriptor list as `/rate` (unknown node / disallowed modifier → 400); omitted = `[]`. See `docs/dev/social-feed.md`. |
| PATCH | /api/checkins/:id | Edit own feed post. `:id` is a `feed_items.id`. Standalone kind: partial body `{productId? + vintageId? \| create?, vinification?, description?, purchaseUrl?, score?, flavors?, aromas?, notes?, imageData?, venueName?, city?, country?, lat?, lng?, taggedUserIds?}` — `aromas` is present-replaces / omitted-preserves (a present `[]` clears, an omitted field keeps stored selections); image replace reclaims old S3. Changing the wine is a re-link (a pick or a create; the snapshot follows, stored flavours are re-fitted to the new wine's axes); typed name / producer / year are ignored. Session kind: rating-only body `{wineId, score?, flavors?, aromas?, notes?}` against the caller's own rating (fields outside those five are ignored, not rejected); an edit that empties the rating runs the engagement-deletion cascade. See `docs/dev/social-feed.md`. |
| DELETE | /api/checkins/:id | Delete own standalone check-in. Cascades rating + feed_item + rating_images. Someone else's id is a 404, like a missing one (PATCH too). |
| POST/DELETE | /api/feed-items/:id/crave | Save / unsave a bottle from someone's post → `{ok, saved}`. A moment post names the row by its key, body `{ratingId}` (the author's rating, on every row: a hidden bottle on someone else's post has no wine id); a check-in needs no body (its bottle is the post's own), the moment's rules (a redacted "Wine N" saves that bottle only). 404 when the post is hidden from you, the bottle isn't the post's, a moment post comes without its key, or its line-up is hidden from you (all before the budget). One budget with the moment's save (300/h). On your Cravings, such a bottle's photo and id show only to viewers who may see that post. Feed rows carry `saved` (and a check-in its `wineId`) |
| POST/DELETE | /api/feed-items/:id/like | Like / unlike a feed item (check-in or session post) → `{liked, count}`. 404 when the post's author hides it from you; an unlike of your own like on a post now hidden from you still works and answers `{liked: false}` without a count (except when the author blocks you: 404). The `:id` value matches the legacy `/api/checkins/:id/like` shape for migrated rows — id-equality preserved by the rewire phase 2 data migration. |
| POST/DELETE | /api/users/:id/follow | Follow / unfollow a user (no self-follow). An unknown id answers like a real one (200 after the limiter) |
| GET | /api/users/:id | Public profile + stats; viewer's `isFollowing` flag when authed. The full profile also carries `followsYou`, `friendsCount` (mutual follows), `inCommon` (`{count, faces: [{id, name, username, imageUrl}]}`: their friends YOU follow, block pairs with either of you left out, each face's photo by that person's own visibility; absent on your own profile) and `tiles` (`{impressions?, moments?, cravings?}`, each `{count, imageUrl}`; a tile the owner hides from you is ABSENT: Impressions with their posts, Moments / Cravings by their Show switches; the automatic photo is never one from an unrevealed blind wine; a chosen tile cover shows while its source exists, and your own profile adds `pinned`), `checkinsAudience` (only when their Check-Ins Visible To hides their posts from you), plus `bio` and `coverPhotoUrl`. When their posts are hidden, `recentCheckins` / `recentSessionPosts` are empty and `stats.checkins` is absent; `stats.sessions` is absent when they hide Moments. `?view=header` drops `recentCheckins`/`recentSessionPosts`. A private (tier-gated) profile answers `{id, name, username, gated: true, isFollowing, followsYou}`. Every person object outside a moment carries `username` (`null` until that person chose one) beside `name`: profiles, people rows, search, friends, tasted-with, the Blocked / Muted lists, feed authors and tags, `/api/me/account`. |
| GET | /api/users/:id/followers, /api/users/:id/following | Someone's followers / following, newest follow first, 30 per page (`?cursor=`: opaque and bound to this list, viewer and filters; a tampered or foreign one answers an empty page), `?mutual=mutual` (= Friends) or `non`, `?q=` (name or username, ≥ 2 chars; `@…` = the username only), `?known=1` (only people you follow; ignored on your own list); auth required, 404 unless you may see their profile. Rows `{id, name, username, xp, imageUrl, isFollowing, viewerMutes, profileFollowsThem, followsViewer, momentsTogether, friendsInCommon}`: block pairs with the owner or you are left out, `xp` / `imageUrl` / `friendsInCommon` are null when that person's visibility hides their profile from you, the two lines null on your own row. The first page of someone else's list (no cursor, no `q`) carries `knownCount` |
| GET | /api/users/:id/impressions | Someone's (or your) impressions: every rating, through their post visibility (200 with no items when their posts are hidden from you), 30 per page (`?cursor=`, bound to the sort). `?sort=newest` (default: newest post first) \| `oldest` \| `highest` \| `lowest` (their score, unrated last; anything else reads as newest). `?q` (shown fields only: a blind row matches its moment name), `from` / `to` (ISO instants), `category`, `min` / `max` (quarter steps in 0.25–5, `min ≤ max`, else 400; any range drops unscored ones), `st` (structure ranges `sweet:1-3,tannin:0-0`: whole 0–5, `lo ≤ hi`, each wine axis once (Bubbles too, matching only a wine that is sparkling now), else 400; an unrated axis never matches), `ar` (aroma picks, JSON `[{a, m?, p?}]` in the stored selection shape, through the aroma gate, else 400; each read broad: a node finds everything under it, no modifier = any, `p` = only Pronounced, a promoted leaf counts for its base) + `armode=any` (any of them; default all), `common=1` (someone else's: only the ones you both had). Rows `{id, postId, wineId?, name, vintage, producer, type, category, imageUrl, score, hadAt, blind?, momentName?, yourScore?}` (`id` = the rating, the row's key); a blind row has no name, producer, vintage or photo, and no `wineId` unless the list is your own; hidden line-ups are left out. The first page of someone else's carries `commonCount` (blind rows never count); on someone else's list `st` / `ar` only match rows with a post (that is where they show). Auth required; 404 unless you may see their profile |
| GET | /api/users/:id/moments | Someone's moments, ONLY the ones you share (you both hold a member row, neither kicked, you not banned, the moment live), newest first, when their Show Moments lets you (200 with no items when not). The same filter params as `/api/me/sessions` (`q`, `from`, `to`, `roles` = THEIR role, `hosts`, `people`, `category`, `cursor`, `limit`). Rows `{code, name, dateFrom, dateTo, createdAt, address, coverPhotoUrl, category, role}`; the first page carries `otherCount` (their other moments, unfiltered). A moment you're not in is never a row, a name or a code. Your own moments: `/api/me/sessions` |
| GET | /api/users/:id/cravings | Someone's (or your) cravings, when their Show Cravings lets you. `?sort=recent` (default) or `score` (their score; served as recent when their posts are hidden from you), `?q`, `?cursor=` (opaque, bound to this list, viewer, sort and search; no save time on the wire). Rows `{wineId?, postId, name, vintage, producer, type, colour, sparkling, imageUrl, score}` (`wineId` while the craving still has its bottle, and for a bottle saved from someone's post only to viewers who may see that post, like its photo; the score, post and photo from their latest rating of that wine you may see), plus on your own `key` (`DELETE /api/me/bookmarks/:key`) and `momentName?`; their score and post only through their post visibility. A craving whose bottle is still hidden for its owner is left out (theirs and yours alike); someone else's also leave out what is hidden for you and bottles whose moment can't be found |
| GET | /api/users/:id/badges | A user's badges over the full catalog (`earned`, `earned_at`); auth required, 404 unless you may see their profile. `earned_at` is `null` for everyone but the owner |
| GET | /api/me/friends | Mutual follows of the calling user |
| DELETE | /api/me/bookmarks/:key | Remove one of your cravings by its key (a Saved vintage's or your Cravings row's `key`: a craving's id, or `m` + a blind save's id), with the rest of that wine as the list shows it. Someone else's, a missing or a still-hidden one → 404 |

**Discovery / venue**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/users/by-username/:username | The same profile answer as `/api/users/:id`, looked up by username (case-insensitive, the format only: a name an operator assigned opens too). Malformed → 400; unknown, renamed away or held → 404. Shares the profile limiter |
| GET | /api/me/username | Your username: `{username, changesLeft, nextChangeAt, previous: {username, heldUntil} \| null}` (`username: null` = not chosen yet; `previous` = your old name while it is held for you) |
| PUT | /api/me/username | Set or change it: `{username}` → the GET's shape. Lowercase `a-z 0-9 . _`, 3 to 30, no `..`, no dot at either end, at least one letter or digit, not reserved; stored lowercase. 400 `{error, code: 'invalid' \| 'reserved'}`; 409 `{code: 'taken'}` (taken, or held for someone else); 409 `{code: 'quota', nextChangeAt}` (5 changes per 90 days; the first choice is free) |
| GET | /api/me/username/available | `?username=` → `{available, reason?: 'invalid' \| 'reserved' \| 'taken'}` (advisory; auth required) |
| GET | /api/users/search | Display-name or username substring lookup (`@sim` = the username only), an exact username first, then username prefixes, then by name; first 10 (auth required, rate-limited; block pairs left out before the limit; `xp` / `badgeCount` / `imageUrl` / `friendsInCommon` only when that person's visibility admits you, else a `gated` stub; every row adds `followsViewer` + `momentsTogether`; you never find yourself) |
| GET | /api/me/tasted-with | People you shared a started moment with and don't follow (never muted people or block pairs), up to 8, newest shared moment first → `{people: [{id, name, imageUrl, followsViewer, lastMoment: {name, at}}]}` |
| POST | /api/places | Venue search adapter — Google Places (with key) or OSM (without). Signed in only (401), same-origin; `query` ≤ 100 chars, valid coordinates (400); per-account + per-address limits (429), app-wide caps answer `{ results: [] }` |

**Wine catalog** — the shared producer/product/vintage reference data. Every new bottle (a moment's, a check-in's) is a catalogue wine: picked by `productId`/`vintageId`, or created with `create` on the wine and check-in endpoints above. Open to everyone signed in by default; `CATALOG_PUBLIC_ENABLED=false` is the kill switch (search and creation then answer 404 to everyone but staff, see `docs/dev/deployment.md`). Guests search inside their moment (`/api/session/:code/catalog/search`) and never create.

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/catalog/search | Suggestions — `?kind=bottle&q=` (the app's one field: producer, wine, region and year in any order; every typed word must match, the last as a start of a word, small typos allowed, words like "Weingut" or "Domaine" optional; one row per wine `{id, name, producerId, producerName, colour, sparkling, style, region, score, year}`, `year` = the typed year carried onto the row, null when none was typed or the wine's name holds that number), `?kind=producer&q=` (the same every-word rule over producers; `&similar=1`, the website's producer step: when every word finds nothing, the forgiving similarity list instead, `similar: true` in the answer), `?kind=product&q=&producerId=`, or `?kind=vintages&productId=` (that wine's years: `[{id, year}]`, NV = `year: null`; an unknown or unavailable wine is the generic 400). `bottle` and `producer` answer `{ results, more, tooLong }` (`producer` also `exact`: a listed producer has exactly the typed name, accents and ß/ss aside; `bottle` also `close`: no wine holds every typed word, these hold all but one, from 3 words typed): `more` = the list may be incomplete (type more), `tooLong` = over 16 words or 200 characters, refused with no results. Returns likely matches for a person to choose from; picking one is always an explicit choice, never automatic. Signed in; 30/min, shared with the moment's search |
| POST | /api/catalog/entries | Create catalog entries for a wine being added. Body `{producerId?, producer?, product, year?, abv?, collaboratorIds?}` (or `{productId, year, abv?}`: a missing year of an existing wine) — supply `producerId` for an existing maker or `producer` to create one. `product` is `{name, category?, colour?, sparkling?, style?, grapes?, region?, country?}`: a wine needs a TYPE, `colour` (`red`, `white`, `rose`) or `sparkling: true` (400 otherwise); `colour` null = unknown, and for wine `style` is `dessert`, `fortified` or null; `country` is where the wine is FROM (ISO code). `abv` (0 to 25) is the bottle's alcohol: on the vintage when a year (or NV) is given, else on the wine; alcohol-free is derived from it (≤ 0.5 %). An omitted field takes its default; a present invalid one is a 400 (the old style values `red`, `spark`, `nonalc` etc. are rejected, not mapped). `year` absent = link at product level (year unknown), `null` = the non-vintage bottling, a number = that vintage. Everything created here is provisional and enters the review queue. 60/h |

**Public**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/legal/attributions | Corpus-level sources + licences for the wine catalog. Unauthenticated by design — the native app fetches it, and a legal surface must render before an account exists. Returns `{entries, servedAt}`; entries are `{id, source, sourceUrl, licence:{spdx,url,text}, attribution, verified, notes, dataPeriod?}` |
| GET | /api/build | The commit this instance runs (`{build}`, from Deplo.io's `DEPLOIO_GIT_REVISION`; `dev` elsewhere), `no-store`. The release checks every instance with it |
