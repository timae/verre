# Verre — Wine Tasting OS

Shared wine tasting sessions with radar flavour profiles, per-person ratings, and PDF export. Runs on Deploio with Redis KVS.

## Architecture

```
Browser ──→ Express (Node 20) ──→ Redis (Deploio KVS)
              ↕
        static HTML
```

- **Shared wine list** — host creates a session, guests join with a 4-char code
- **Private ratings** — each person rates independently on their own device
- **Compare** — view any participant's ratings, or overlay everyone's profiles per wine
- **PDF export** — print stylesheet renders a clean A4 tasting report
- Sessions auto-expire after 48 hours

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

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/session | Create session (body: `{hostName}`) → `{code}` |
| POST | /api/session/join | Join session (body: `{code, userName}`) |
| GET | /api/session/:code | Session info + participants |
| GET | /api/session/:code/wines | Wine list |
| POST | /api/session/:code/wines | Add wine |
| DELETE | /api/session/:code/wines/:id | Delete wine |
| POST | /api/session/:code/rate | Submit rating (body: `{userName, wineId, score, flavors, notes}`) |
| GET | /api/session/:code/ratings | All ratings (all users) |
| GET | /api/session/:code/ratings/:user | One user's ratings |
