// Prisma 7 CLI configuration. The datasource URL lives here, not in
// schema.prisma (a `url =` there is a validation error on 7), and the 7 CLI no
// longer loads `.env` itself, so this file does — quietly, and without
// overriding variables that are already set, so Deplo.io's process env and an
// explicit `DATABASE_URL=… npx prisma …` both win over the local file.
//
// `process.env.DATABASE_URL` rather than Prisma's `env()` helper on purpose:
// `env()` throws while the config loads when the variable is missing, which
// would break `prisma generate` in the Docker builder stage (no database
// there). A plain read lets `generate` run without a URL while every
// migrate/db command still fails loud ("datasource.url property is required").
//
// `shadowDatabaseUrl` is read only by `migrate diff --from-migrations` in CI
// (.github/workflows/check-schema.yml replays the migration chain into it);
// `migrate dev` keeps creating its own temporary shadow database.
//
// The image copies this file to /migrate next to prisma/ so the deploy job and
// the cleanup cron find it from their cwd (Dockerfile, .deploio.yaml).
import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'prisma/config'

loadEnv({ quiet: true })

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
