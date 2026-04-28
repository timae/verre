# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local development

```bash
docker run -d -p 6379:6379 redis:7-alpine   # Redis
npm install
node server.js                               # → http://localhost:8080
```

No build step. The server serves `public/index.html` as a static file. Changes to the frontend are live on refresh; changes to `server.js` or routes require restarting the Node process.

Syntax-check server-side JS:
```bash
node --check server.js
node --check routes/auth.js routes/me.js
```

Check inline JS in `public/index.html`:
```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('public/index.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
try{new Function(m[1]);console.log('JS OK');}catch(e){console.log('ERROR:',e.message);}
"
```

Run schema migration against production Postgres (Nine Eco):
```bash
PGSSLMODE=require psql "$DATABASE_URL" -f db/schema.sql
```

## Architecture

### Two-tier persistence

| Layer | Technology | Responsibility |
|---|---|---|
| Active sessions | Redis (48h TTL) | Live wine list, ratings, participants |
| Accounts & history | Nine Eco PostgreSQL | Users, archived sessions, bookmarks, Hall of Fame |
| Images | Nine Object Storage (S3-compatible) | Bottle photos stored by URL |

**Redis key namespace:** `s:{CODE}:meta`, `s:{CODE}:wines`, `s:{CODE}:r:{USER}:{WINEID}`, `s:{CODE}:users`

**Postgres archival is incremental:** data flows from Redis → Postgres only when a logged-in user commits a rating (`POST /api/session/:code/rate`) or joins a session (`POST /api/session/:code/visit`). Anonymous sessions stay Redis-only for 48h then expire.

### Freemium split

- **Anonymous / free**: session-based, Redis only, 48h lifespan. No account required.
- **Logged-in (free account)**: same live session, but visit + ratings are archived to Postgres. History, bookmarks, Hall of Fame entries, and flavour profile persist indefinitely.
- **Pro** (`users.pro = true`): future paid tier — `purchase_url` on wines, vendor role.

### Auth

JWT stored in browser `localStorage` as `vr_token`. Expiry: 30 days. Token payload: `{userId, name, role, pro}`.

`optionalAuth` middleware (applied globally) populates `req.user` if a valid Bearer token is present; routes work for anonymous callers too. `requireAuth` is used only for `GET /api/me/*` endpoints.

Host verification for wine mutations uses `isHost(meta, req)` which checks `req.user.userId === meta.hostUserId` for authenticated users, falling back to `req.body.userName === meta.host` for anonymous sessions. All wine mutation requests (`POST`, `PATCH`, `DELETE`, reorder) must include `userName: S.user` in the body.

### Frontend structure

Everything lives in `public/index.html` — one large file with inline CSS, HTML screens, and a `<script>` block. Screens are `<div class="screen">` elements toggled with `display:none/block`. No build step, no bundler.

Key client-side state object:
```javascript
S = {
  user,        // display name in current session
  code,        // 4-char session code
  isHost,      // whether current user created the session
  sessionName, // optional human-readable session alias
  authToken,   // JWT from localStorage
  authUser,    // {id, name, email, role, pro}
  bookmarks,   // Set of bookmarked wine IDs
  wines, allRatings, curId, fromTab, cmpUser, selType
}
```

Navigation: `tab(t)` switches between screens (`wines`, `rate`, `compare`, `saved`, `history`, `profile`). Dashboard nav (logged-in, no session) vs session nav (in a session) are toggled by `showDashboardNav()` / `showSessionNav()`.

### Flavour chart system

Two chart types coexist:
- **Polar chart** (`drawPolarChart(id, flavors, sz, fl)`) — arc segments per dimension. Used for single-wine detail, compare cards, and user profile. Takes an optional `fl` array; if omitted, `detectFL(flavors)` infers the right one from stored key names.
- **Radar** (`drawRadar(...)`) — polygon overlay. Used only for multi-wine compare overlays where shapes need to be compared visually.

Flavour dimensions are **type-specific**:
- `FL_RED`: dark_fruit, red_fruit, earth, spice, oak, tannin, body, acid, herbal, floral
- `FL_WHITE`: citrus, stone, tropical, floral, herbal, mineral, oak, body, acid, sweet
- `FL_SPARK`: floral_herb, citrus, tree_fruit, red_fruit, dried_fruit, earth, creamy, oak, nutty, acid
- `FL_ROSE`: red_fruit, citrus, floral, stone, herbal, mineral, body, acid, sweet, tropical
- Legacy `FL` (generic 10 keys): used for old ratings and profile aggregation

`detectFL(flavors)` identifies which array applies by checking key names. Existing ratings always keep their stored keys — switching wine type never migrates old flavor data.

### Deployment (Deploio / Nine)

- App: `moonlit-pond`, project: `timgrethler`, branch: `feature/postgres-s3-auth`
- Live URL: `tasting.tgweb.li`
- `REDIS_URL`, `DATABASE_URL`, `JWT_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION=us-east-1` are set as env vars in Deploio
- S3 endpoint: `https://es34.objects.nineapis.ch` (Nine Object Storage, region always `us-east-1`)
- Postgres: `verre.d600599.db.postgres.nineapis.ch`, TLS with `rejectUnauthorized: false`
- Deploio builds from the Dockerfile on every push to the tracked branch

### Schema notes for future features

These columns exist in the schema but are not yet wired to UI:
- `sessions.blind` — blind tasting mode (wines hidden from tasters until host reveals)
- `wines.revealed_at` — timestamp when a blind wine is revealed
- `wines.purchase_url` — vendor/pro feature: link to purchase
- `ratings.is_host` — distinguishes host pre-ratings from taster ratings (blind tastings)
- `users.role = 'vendor'` / `users.pro = true` — paid tier hooks
- `wines.category` — extensible drink type beyond wine (beer, spirit, kombucha)
