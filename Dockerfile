# ── Verre v3 — Next.js 15 ─────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# App runtime: lean Next.js standalone bundle with only the deps it uses.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Migration tooling at /migrate. Fresh `npm ci --omit=dev` here gives the
# Prisma CLI a complete prod-only dependency tree (no typescript / eslint /
# tailwind, but with prisma + @prisma/* + transitive deps like effect, c12).
# The Deploio deploy job (.deploio.yaml) cd's into /migrate before invoking
# `prisma migrate deploy`. Kept separate from /app so it doesn't disturb
# the Next.js standalone bundle.
COPY --from=builder /app/package*.json /migrate/
COPY --from=builder /app/prisma /migrate/prisma
WORKDIR /migrate
RUN npm ci --omit=dev && npx prisma generate
WORKDIR /app

EXPOSE 8080
CMD ["node", "server.js"]
