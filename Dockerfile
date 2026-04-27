# ── Verre — Wine Tasting OS ───────────────────
# Deploio requires the app to listen on $PORT (default 8080).
# We use nginx:alpine's built-in envsubst template support.

FROM nginx:alpine

# Install envsubst (gettext)
RUN apk add --no-cache gettext

# Remove default nginx content
RUN rm -rf /usr/share/nginx/html/*

# Copy app
COPY index.html /usr/share/nginx/html/index.html

# nginx:alpine auto-processes files in /etc/nginx/templates/
# replacing env vars (like $PORT) before starting
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
