// One-shot backfill of the `users.lifetime_*` snapshot columns from the
// existing ratings/session data. Run ONCE, after `prisma db push` has added
// the new columns. Idempotent: re-running overwrites the snapshots with the
// same recomputed values, so safe to run twice if needed.
//
// Usage:  node scripts/backfill-lifetime-counters.mjs
//
// Exits 0 on success, 1 on any error.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Backfilling lifetime counters...')

  // One UPDATE per user, computed from live aggregations. Single statement —
  // Postgres handles the joins. Faster than iterating users in JS.
  //
  // first_rated_at = MIN(rated_at) for the user.
  // lifetime_consecutive_months = COUNT(DISTINCT month bucket).
  // lifetime_photos_added = DISTINCT wines they rated that have an image.
  await prisma.$executeRawUnsafe(`
    UPDATE users u SET
      lifetime_ratings = COALESCE(r.total, 0),
      lifetime_five_star = COALESCE(r.fives, 0),
      lifetime_one_star = COALESCE(r.ones, 0),
      lifetime_notes_written = COALESCE(r.notes, 0),
      lifetime_max_note_len = COALESCE(r.max_note, 0),
      lifetime_consecutive_months = COALESCE(r.months, 0),
      first_rated_at = r.first_at,
      lifetime_photos_added = COALESCE(p.cnt, 0)
    FROM (
      SELECT
        user_id,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE score = 5) AS fives,
        COUNT(*) FILTER (WHERE score = 1) AS ones,
        COUNT(*) FILTER (WHERE notes IS NOT NULL AND LENGTH(notes) > 5) AS notes,
        COALESCE(MAX(LENGTH(notes)), 0) AS max_note,
        COUNT(DISTINCT DATE_TRUNC('month', rated_at)) AS months,
        MIN(rated_at) AS first_at
      FROM ratings
      WHERE user_id IS NOT NULL
      GROUP BY user_id
    ) r
    LEFT JOIN (
      SELECT r2.user_id, COUNT(DISTINCT r2.wine_id) AS cnt
      FROM ratings r2
      JOIN wines w ON w.id = r2.wine_id
      WHERE r2.user_id IS NOT NULL AND w.image_url IS NOT NULL
      GROUP BY r2.user_id
    ) p ON p.user_id = r.user_id
    WHERE u.id = r.user_id
  `)

  await prisma.$executeRawUnsafe(`
    UPDATE users u SET
      lifetime_sessions_joined = COALESCE(j.cnt, 0)
    FROM (
      SELECT user_id, COUNT(DISTINCT session_code) AS cnt
      FROM session_members
      GROUP BY user_id
    ) j
    WHERE u.id = j.user_id
  `)

  await prisma.$executeRawUnsafe(`
    UPDATE users u SET
      lifetime_sessions_hosted = COALESCE(h.cnt, 0)
    FROM (
      SELECT host_user_id, COUNT(*) AS cnt
      FROM sessions
      WHERE host_user_id IS NOT NULL
      GROUP BY host_user_id
    ) h
    WHERE u.id = h.host_user_id
  `)

  const [{ cnt }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS cnt FROM users WHERE lifetime_ratings > 0 OR lifetime_sessions_joined > 0`
  )
  console.log(`Updated ${cnt} users with non-zero counters.`)
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
