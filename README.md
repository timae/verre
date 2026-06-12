# Verre — Wine Tasting OS

Mobile-first shared wine tasting sessions with a live bottle list, per-person radar ratings, bottle photos, and print-ready export. Runs on Deploio with Redis + Postgres + S3-compatible object storage.

## What it does

- Create or join a tasting with a short shareable code
- Keep one shared bottle lineup across the whole table
- Rate privately on each phone with stars, flavour radar, and notes
- Sign up for an account to keep your history, or stay anonymous
- Compare participants or overlay profiles per bottle
- Attach bottle photos for the session list, detail view, and export
- Edit wines after creation and reorder the lineup during the tasting
- Share a join link or QR code for fast session entry
- Sessions auto-expire after their chosen lifespan (48h default)
- Save wines you liked across sessions, with full ratings and notes preserved
- Earn badges and XP across all your tastings
- Hall of Fame for every 5★ rating
- Blind tasting mode for hosts (pro)
- Co-host roles to delegate wine management; Provider role for someone bringing their own bottles without full host powers
- Hide the wine lineup before the tasting starts
- Hosts can permanently delete a session and its data; bookmarked wines stay saved
- Hosts can kick or ban participants from a tasting (with optional wine removal); banned users can't rejoin
- Social feed: log standalone check-ins (with photo, location, tagged friends), follow other users, like and discover what your tasting network is drinking
- Public profiles at `/u/<id>` showing recent check-ins and stats
- Optional profile pictures (round-mask cropper, EXIF/GPS stripped before upload)
- Profile visibility tiers (public / Verre users / followers / mutual follows) with optional friends-of-friends extension
- Mute (quietly hide someone's content from your feed) and Block (full break — bidirectional invisibility outside shared sessions, render-only inside)

Optional label scan:
- Bottle photos always work without AI
- Label reading is optional and user-provided
- On this branch, a participant can store their own `OpenAI` or `Claude` API key locally on their device and use it to prefill bottle fields
- Keys are not stored in Redis or sent through the Verre backend on this branch

## Architecture

```
Browser ──→ Next.js 15 (Node 24) ──→ Redis     (live session state, 48h+ TTL)
                                  ─→ Postgres  (accounts, history, bookmarks, HoF)
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

# S3 (MinIO)
docker run -d --name verre-minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -v verre-minio-data:/data \
  minio/minio:latest server /data --console-address ":9001"

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

Local `.env` for the MinIO bucket:
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
npx expo run:ios            # builds the dev client, opens the iOS Simulator
# physical device (backend on your Mac's LAN IP):
EXPO_PUBLIC_API_URL=http://192.168.1.42:3000 npx expo run:ios --device
```

Day-to-day JS iteration after the first build: `npx expo start`. See `apps/mobile/CLAUDE.md` for toolchain rules (SDK pinning, auth-version lockstep, design tokens).

## API

Authentication: logged-in users carry a NextAuth session cookie; anonymous users carry a per-session `x-vr-anon-token` header. See `CLAUDE.md` for the full authorization rules per endpoint.

**Auth + account**

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | /api/auth/[...nextauth] | NextAuth sign-in / sign-out |
| POST | /api/auth/register | Create an account |
| GET | /api/me/profile | Flavour profile + rating stats |
| GET | /api/me/sessions | Sessions this user joined (incl. wine_count, live taster_count, caller's role, live/past status) |
| GET | /api/me/bookmarks | Saved wines |
| GET | /api/me/ratings | This user's rating history |
| GET / POST / PATCH | /api/me/badges | Earned badges, XP, manual recheck, mark-as-seen |
| PATCH | /api/me/account | Edit own name / email / password (pw change revokes other devices) |
| DELETE | /api/me/account | Delete own account (password re-auth required) |
| GET | /api/me/devices | List own active device sessions; 60/min |
| DELETE | /api/me/devices/:id | Revoke one device; cross-device needs password; 30/h |
| DELETE | /api/me/devices | Revoke all other devices; password re-auth; 10/h |
| POST | /api/me/avatar | Upload / replace own profile picture (body: `{imageData}`); reclaims old S3 |
| DELETE | /api/me/avatar | Remove own profile picture; reclaims S3 |
| GET | /api/me/visibility | Read own profile-visibility settings → `{visibility, fofEnabled}` |
| PATCH | /api/me/visibility | Update own profile-visibility (body: `{visibility, fofEnabled}`); 30/h |
| POST | /api/me/mutes/:id | Mute user `:id`; 60/h shared with DELETE |
| DELETE | /api/me/mutes/:id | Unmute user `:id`; idempotent |
| GET | /api/me/blocks | List of users I've blocked (for the settings UI); newest-first |
| POST | /api/me/blocks/:id | Block user `:id`; 30/h |
| DELETE | /api/me/blocks/:id | Unblock user `:id`; uncapped (recovery path) |

**Sessions**

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/session | Create session (body: `{hostDisplayName, sessionName?, blind?, lifespan?, category?, coverPhoto?, dateFrom?, dateTo?, timezone?, address?, description?, link?, hideLineup?, hideLineupMinutesBefore?}`; `coverPhoto` is a base64 data URL, logged-in only; native callers default to unlimited lifespan) → `{code, id, displayName, category, coverPhotoUrl?, anonToken?}` |
| POST | /api/session/join | Join session (body: `{code, displayName}`) → `{id, displayName, anonToken?}` |
| GET | /api/session/:code | Session meta + participants (participant-gated) |
| GET | /api/session/:code/state | Aggregate poll: `{meta, wines, ratings}` in one response (participant-gated; a section is `null` when it failed server-side) |
| PATCH | /api/session/:code | Role assignment via `action: 'set-role'` (host or cohost, with strict-host required for transitions touching `co_host`) |
| DELETE | /api/session/:code | Delete session permanently (host-only) |
| POST | /api/session/:code/visit | Mark logged-in user as a participant of this session |
| POST | /api/session/:code/leave | Kicked-user self-service. `?cleanup=keep` (default no-op) or `?cleanup=full` (deletes ratings/hof/bookmarks) |
| PATCH | /api/session/:code/settings | Edit session metadata (host-only; pro-gated for blind/lifespan; `coverPhoto` data URL = replace / `null` = remove, logged-in only) |
| PATCH | /api/session/:code/name | Rename session (host-only) |
| PATCH | /api/session/:code/me/name | Anon participant renames themselves in this session (body: `{name}`) → `{name: <possibly-emoji-suffixed>}`. Logged-in users use profile settings instead. 10/min/identity |
| GET | /api/session/:code/bans | List banned identities (host + cohost) |
| POST | /api/session/:code/bans | Kick or ban a participant (body: `{identityId, mode: 'kick'\|'ban', deleteAddedWines?}`). Strict-host required when target is a cohost |
| DELETE | /api/session/:code/bans/:identityId | Unban (host + cohost); shares 60/10min rate limit with POST |
| GET | /api/session/:code/bans/preview/:identityId | Preview before kick/ban (host + cohost) |
| GET | /api/session/:code/removed-state | Caller's own removed-state, used by the `?removed=1` bounce screen |

**Wines**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/session/:code/wines | Wine list (participant-gated; redacts blind wines for non-hosts) |
| POST | /api/session/:code/wines | Add wine (host or provider) |
| PATCH | /api/session/:code/wines/:wineId | Edit wine metadata or bottle photo (host or provider-of-own-wine) |
| DELETE | /api/session/:code/wines/:wineId | Delete wine (host or provider-of-own-wine) |
| POST | /api/session/:code/wines/reorder | Reorder wines (host-only; body: `{orderedIds}`) |
| POST/DELETE | /api/session/:code/wines/:wineId/reveal | Reveal/hide a single blind wine (host-only) |
| POST | /api/session/:code/wines/reveal-all | Reveal every blind wine (host-only) |
| POST | /api/session/:code/wines/hide-all | Hide every revealed wine (host-only) |
| POST/DELETE | /api/session/:code/wines/:wineId/bookmark | Save / unsave a wine (logged-in only) |

**Ratings**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/session/:code/ratings | All ratings, id-keyed (participant-gated) |
| POST | /api/session/:code/rate | Submit own rating (body: `{wineId, score, flavors, notes}`) |
| DELETE | /api/session/:code/rate/:wineId | Reset own rating |

**Social feed** (logged-in)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/feed | Network feed — your follows + tasting buddies (cursor-paginated) |
| POST | /api/checkins | Create a standalone check-in. Body: `{wineName, type?, score?, flavors?, notes?, imageData?, venueName?, city?, country?, lat?, lng?, taggedUserIds?, copyFromCheckinId?}`. See `docs/dev/social-feed.md`. |
| PATCH | /api/checkins/:id | Edit own standalone check-in. `:id` is a `feed_items.id`. Image replace reclaims old S3. |
| DELETE | /api/checkins/:id | Delete own standalone check-in. Cascades rating + feed_item + rating_images. |
| POST/DELETE | /api/feed-items/:id/like | Like / unlike a feed item (check-in or session post). The `:id` value matches the legacy `/api/checkins/:id/like` shape for migrated rows — id-equality preserved by the rewire phase 2 data migration. |
| POST/DELETE | /api/users/:id/follow | Follow / unfollow a user (no self-follow) |
| GET | /api/users/:id | Public profile + stats; viewer's `isFollowing` flag when authed |
| GET | /api/me/friends | Mutual follows of the calling user |
| DELETE | /api/me/bookmarks/:wineId | Unbookmark; works on orphaned wines too |

**Discovery / venue**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/users/search | Display-name substring lookup (auth required, rate-limited; results filtered by profile visibility) |
| POST | /api/places | Venue search adapter — Google Places (with key) or OSM (without) |

**Public**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/hof | Hall of Fame leaderboard |
