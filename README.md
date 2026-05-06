# Verre — Wine Tasting OS

Mobile-first shared wine tasting sessions with a live bottle list, per-person radar ratings, bottle photos, and print-ready export. Runs on Deploio with Redis + Postgres + S3-compatible object storage.

## What it does

- Create or join a tasting with a 4-character session code
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
- Co-host roles to delegate wine management
- Hide the wine lineup before the tasting starts
- Hosts can permanently delete a session and its data; bookmarked wines stay saved
- Social feed: log standalone check-ins (with photo, location, tagged friends), follow other users, like and discover what your tasting network is drinking
- Public profiles at `/u/<id>` showing recent check-ins and stats

Optional label scan:
- Bottle photos always work without AI
- Label reading is optional and user-provided
- On this branch, a participant can store their own `OpenAI` or `Claude` API key locally on their device and use it to prefill bottle fields
- Keys are not stored in Redis or sent through the Verre backend on this branch

## Architecture

```
Browser ──→ Next.js 15 (Node 20) ──→ Redis     (live session state, 48h+ TTL)
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
# CNAME  tasting  →  your-app.d600599.deploio.app  (DNS only, grey cloud)
# TXT    _deploio.tasting  →  deploio-site-verification=...
# SSL/TLS mode: Full
```

## Local development

```bash
# Start Redis
docker run -d -p 6379:6379 redis:7-alpine

# Postgres: either run locally (docker) or point DATABASE_URL at a dev DB.
# Then apply migrations to set up the schema:
npx prisma migrate deploy

# Start app
npm install
npx prisma generate
npm run dev
# → http://localhost:3000
```

Open `http://localhost:3000`, create a session, and join from a second device if you want to test the shared flow.

## API

Authentication: logged-in users carry a NextAuth session cookie; anonymous users carry a per-session `x-vr-anon-token` header. See `CLAUDE.md` for the full authorization rules per endpoint.

**Auth + account**

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | /api/auth/[...nextauth] | NextAuth sign-in / sign-out |
| POST | /api/auth/register | Create an account |
| GET | /api/me/profile | Flavour profile + rating stats |
| GET | /api/me/sessions | Sessions this user joined |
| GET | /api/me/bookmarks | Saved wines |
| GET | /api/me/ratings | This user's rating history |
| GET / POST / PATCH | /api/me/badges | Earned badges, XP, manual recheck, mark-as-seen |
| PATCH | /api/me/account | Edit own name / email / password |
| DELETE | /api/me/account | Delete own account (password re-auth required) |

**Sessions**

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/session | Create session (body: `{hostDisplayName, sessionName?, blind?, lifespan?}`) → `{code, id, displayName, anonToken?}` |
| POST | /api/session/join | Join session (body: `{code, displayName}`) → `{id, displayName, anonToken?}` |
| GET | /api/session/:code | Session meta + participants (participant-gated) |
| PATCH | /api/session/:code | Cohost role assignment (host-only) |
| DELETE | /api/session/:code | Delete session permanently (host-only) |
| POST | /api/session/:code/visit | Mark logged-in user as a participant of this session |
| PATCH | /api/session/:code/settings | Edit session metadata (host-only; pro-gated for blind/lifespan) |
| PATCH | /api/session/:code/name | Rename session (host-only) |

**Wines**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/session/:code/wines | Wine list (participant-gated; redacts blind wines for non-hosts) |
| POST | /api/session/:code/wines | Add wine (host-only) |
| PATCH | /api/session/:code/wines/:wineId | Edit wine metadata or bottle photo (host-only) |
| DELETE | /api/session/:code/wines/:wineId | Delete wine (host-only) |
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
| POST | /api/checkins | Create a check-in (body: `{wineName, type?, score?, flavors?, notes?, imageData?, venueName?, city?, country?, lat?, lng?, isPublic?, taggedUserIds?}`) |
| PATCH | /api/checkins/:id | Edit own check-in; image replace reclaims old S3 |
| DELETE | /api/checkins/:id | Delete own check-in; reclaims S3 image |
| POST/DELETE | /api/checkins/:id/like | Like / unlike a check-in |
| POST/DELETE | /api/users/:id/follow | Follow / unfollow a user (no self-follow) |
| GET | /api/users/:id | Public profile + stats; viewer's `isFollowing` flag when authed |
| GET | /api/me/friends | Mutual follows of the calling user |
| DELETE | /api/me/bookmarks/:wineId | Unbookmark; works on orphaned wines too |

**Discovery / venue**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/users/search | Display-name prefix lookup (rate-limited) |
| POST | /api/places | Venue search adapter — Google Places (with key) or OSM (without) |

**Public**

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/hof | Hall of Fame leaderboard |
