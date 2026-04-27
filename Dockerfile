# ── Verre — Wine Tasting OS ───────────────────
# Node.js backend + static frontend
# Deploio provides $PORT (default 8080) and $REDIS_URL via env vars

FROM node:20-bullseye

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  libglib2.0-0 \
  libgl1 \
  libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy app code
COPY server.js ./
COPY ocr_extract.py ./
COPY public/ ./public/

EXPOSE 8080

CMD ["node", "server.js"]
