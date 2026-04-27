# Verre — Wine Tasting OS

A nerdy, monospace-forward wine tasting app. Session-based ratings, radar flavour profiles, per-wine notes, ranking table and overlay comparison. Runs entirely in the browser — no backend needed.

## Run locally with Docker

```bash
docker build -t verre .
docker run -p 8080:80 verre
```

Open: http://localhost:8080

## Deploy to Deploio

1. Push this folder to a GitHub repo (or zip and upload)
2. In Deploio: New Service → Docker
3. Point to your repo / Dockerfile
4. Port: **80**
5. Deploy — done.

## How it works

- Pure HTML/CSS/JS — zero frameworks, zero build step
- `sessionStorage` keeps each guest's ratings private on their own device
- Host adds wines once; guests rate independently on their phones
- Share via AirDrop, WhatsApp link, or QR code to the deployed URL

## Stack

```
nginx:alpine   (web server)
└── index.html (entire app, ~600 lines)
```

That's it.
