# ── Verre — Wine Tasting OS ───────────────────
# Node.js backend + static frontend
# Deploio provides $PORT (default 8080) and $REDIS_URL via env vars

FROM node:20-alpine

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy app code
COPY server.js ./
COPY public/ ./public/
COPY db/ ./db/
COPY lib/ ./lib/
COPY middleware/ ./middleware/
COPY routes/ ./routes/

EXPOSE 8080

CMD ["node", "server.js"]
