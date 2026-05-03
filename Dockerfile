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

# Migration tooling at /migrate. Prisma CLI's transitive dependency graph
# (effect → fast-check → …) is non-trivial; copying just node_modules/prisma
# misses several siblings, so we copy the builder's full installed
# node_modules. The Deploio deploy job (.deploio.yaml) cd's into /migrate
# before invoking the Prisma CLI's JS entry directly.
COPY --from=builder /app/prisma /migrate/prisma
COPY --from=builder /app/node_modules /migrate/node_modules

EXPOSE 8080
CMD ["node", "server.js"]
