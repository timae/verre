# prisma/ — Schema and migrations

Local rules for `prisma/*`. Root CLAUDE.md still applies; this is overlay context for schema work.

## Migration workflow

Apply schema changes to the database (Prisma is the single source of truth):

```bash
# Local dev: create a new versioned migration, applies it, regenerates client.
npx prisma migrate dev --name <description>

# Production: applied automatically by Deploio's deploy job (.deploio.yaml).
# Manually triggerable when needed: npx prisma migrate deploy
```

`prisma migrate dev` produces a versioned SQL file in `prisma/migrations/<timestamp>_<name>/migration.sql` that gets committed to git. On the next deploy, Deploio's deploy job runs `npx prisma migrate deploy`, which applies any pending migrations idempotently. The migration succeeds or the deploy is rolled back; the previous release keeps serving production until you fix the issue.

`prisma db push` is **no longer the canonical workflow** — it bypasses migration history. Only use it during early local exploration where you don't yet care about reproducibility, and never against production.

## Destructive schema changes — never automate

Routine, additive schema changes (new columns with defaults, new tables, new indexes, widening varchars, additive foreign keys) flow through the normal migration pipeline and apply automatically on deploy.

**Destructive changes** require explicit human confirmation:

- Dropping a column or table.
- Renaming a column (Prisma sees this as drop + add).
- Type changes that risk data loss (e.g. text → integer).
- Adding `NOT NULL` to a nullable column when NULLs exist.
- Anything Prisma would prompt about with "type 'y' to confirm" or any migration that would need `--accept-data-loss`.

For destructive changes:

1. Surface what data would be lost. Be specific.
2. Prefer a non-destructive sequence first: stop writing to the column → wait → drop in a follow-up. The "expand-then-contract" pattern.
3. If destructive is unavoidable and the user confirms: take a Postgres dump first (`pg_dump`), write the migration explicitly, push during a window the user can monitor.
4. Never use `--accept-data-loss` casually. If Prisma asks for it, that's a flag to stop and reconsider, not a flag to add.

This rule applies regardless of how much "easier" it would be to just drop and recreate. Lost user data doesn't come back from a `git revert`.

## Schema check (build-time)

`.github/workflows/check-schema.yml` runs `prisma migrate diff` and fails the build if `schema.prisma` and the migrations directory disagree. Don't bypass — either generate the migration via `prisma migrate dev` or roll back the schema change.

## Phase 2 data migration (rewire) — historical

`prisma/migrations/20260515011038_rewire_phase2_data/migration.sql` backfilled the new `feed_items` model from the (then-existing) `checkins` tables. Idempotency was guarded via a `_migration_checkpoints` scratch table — both that table and the source `checkins*` tables were dropped in phase 4 (`20260516125827_rewire_phase4_drop_checkins`). The migration file remains in history for audit; do not re-run it. Re-run / partial-failure recovery within its deploy window: `prisma migrate resolve --rolled-back <migration_name>` was the documented escape hatch. Full deploy story (scale to 0 replicas, push merge commit, Deploio runs `prisma migrate deploy`, scale back up): `docs/dev/proposals/rewire.md` §5 + §6 phase 2.

## Schema notes for future features

Columns that exist in the schema but are not yet wired to UI:

- `users.role = 'vendor'` — paid tier hook (the `pro` boolean is wired)
- `wines.category` — extensible drink type beyond wine (beer, spirit, kombucha)

## What doesn't exist (don't invent it)

- **No admin / moderator / staff tier.** The `users.role` enum currently has `user` + `vendor` only (and `vendor` is itself unwired). If a feature requires admin-only routes, surface that to the user and threat-model it before adding a column or a privileged tier. Don't ship `if (user.role === 'admin')` against a value that doesn't exist.
