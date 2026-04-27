# Verre — Wine Tasting OS

Mobile-first shared wine tasting sessions with a live bottle list, per-person radar ratings, bottle photos, and print-ready export. Runs on Deploio with Redis KVS.

## What it does

- Create or join a tasting with a 4-character session code
- Keep one shared bottle lineup across the whole table
- Rate privately on each phone with stars, flavour radar, and notes
- Compare participants or overlay profiles per bottle
- Attach bottle photos for the session list, detail view, and export
- Edit wines after creation and reorder the lineup during the tasting
- Share a join link or QR code for fast session entry
- Auto-expire inactive sessions after 48 hours

Optional label scan:
- Bottle photos always work without AI
- Label reading is optional and user-provided
- On this branch, a participant can store their own `OpenAI` or `Claude` API key locally on their device and use it to prefill bottle fields
- Keys are not stored in Redis or sent through the Verre backend on this branch

## Architecture

```
Browser ──→ Express (Node 20) ──→ Redis (Deploio KVS)
              ↕
     single-page frontend
```

The app is intentionally simple:
- one Node/Express server
- one single-page frontend in `public/index.html`
- one Redis/KVS namespace per tasting session

## Deploy to Deploio

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "init"
gh repo create verre --public --source=. --push
```

### 2. Create KVS

```bash
nctl create kvs verre
nctl get kvs verre                  # → note the FQDN
nctl get kvs verre --print-token    # → note the password
```

### 3. Create app

```bash
nctl create application verre \
  --git-url=https://github.com/YOURUSER/verre \
  --git-revision=main \
  --dockerfile

nctl update app verre \
  --env='REDIS_URL=rediss://:{PASSWORD}@{FQDN}'
```

Or via Cockpit:
1. New Application → your repo → toggle **Dockerfile Build**
2. Set env var `REDIS_URL` = `rediss://:{PASSWORD}@{FQDN}`
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

# Start app
npm install
node server.js
# → http://localhost:8080
```

Open `http://localhost:8080`, create a session, and join from a second device if you want to test the shared flow.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/session | Create session (body: `{hostName}`) → `{code}` |
| POST | /api/session/join | Join session (body: `{code, userName}`) |
| GET | /api/session/:code | Session info + participants |
| GET | /api/session/:code/wines | Wine list |
| POST | /api/session/:code/wines | Add wine |
| PATCH | /api/session/:code/wines/:wineId | Edit wine metadata or bottle photo |
| POST | /api/session/:code/wines/reorder | Reorder wines (body: `{orderedIds}`) |
| DELETE | /api/session/:code/wines/:wineId | Delete wine |
| POST | /api/session/:code/rate | Submit rating (body: `{userName, wineId, score, flavors, notes}`) |
| GET | /api/session/:code/ratings | All ratings (all users) |
| GET | /api/session/:code/ratings/:user | One user's ratings |
