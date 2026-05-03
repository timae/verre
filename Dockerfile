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
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Prisma migration tooling. The Deploio deploy job (.deploio.yaml) runs
# `npx prisma migrate deploy` before each release; this needs the schema,
# the migrations folder, and the prisma CLI itself. The standalone Next.js
# bundle already includes @prisma/client at runtime, so we only ship the
# CLI + migration artefacts to a separate path.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "server.js"]
