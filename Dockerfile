# ── Verre v3 — Next.js 15 ─────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app
# Copy the root manifests AND every workspace package manifest before `npm ci`
# so the install is workspace-aware and links node_modules/@verre/* . If the
# workspace manifest isn't present at install time, `npm ci` silently skips the
# symlink (exits 0) and the later `next build` fails with "Module not found:
# @verre/core". Keeping just the manifests here (not the source) preserves the
# Docker layer cache for the dependency install.
COPY package*.json ./
# One COPY per workspace package — a single `packages/*/package.json` glob can't
# preserve per-package dirs (Docker flattens multiple sources into one dest file).
# When you add a second packages/* member, add its manifest COPY line here too.
COPY packages/core/package.json ./packages/core/
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:24-alpine AS runner
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
# Geo-data refresh script runs from the deploy job alongside migrations
# (best-effort; see scripts/refresh-geo-data.mjs + .deploio.yaml).
COPY --from=builder /app/scripts /migrate/scripts

EXPOSE 8080
CMD ["node", "server.js"]
