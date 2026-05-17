import { prisma } from '@/lib/prisma'

// Legacy FL flavor keys — same set as `lib/flavours.ts` `FL`. Hardcoded
// here so the SQL aggregate is parameter-free; these names map directly
// to JSON keys in `ratings.flavors`. A schema migration would need to
// touch this list too.
//
// Strict regex: these names are interpolated raw into a SQL SELECT list
// (column aliases and JSON path keys). Anything outside `[a-z_]+` would
// either break the query or open it up to injection if the constant is
// ever extended carelessly. The runtime check below catches any future
// edit that forgets that.
export const FL_KEYS = [
  'floral', 'citrus', 'stone', 'tropical', 'herbal',
  'oak', 'body', 'tannin', 'acid', 'sweet',
] as const

if (!FL_KEYS.every(k => /^[a-z_]+$/.test(k))) {
  throw new Error('FL_KEYS contains a value that is unsafe to interpolate into SQL')
}

export type FlavorBlock = {
  // COUNT(*) of the user's *active* rating rows. Can be smaller than
  // users.lifetimeRatings — that snapshot never decrements, this live
  // count reflects current state after session deletions. Owner-only:
  // we strip this field for non-owner viewers (both in the API response
  // at /api/users/[id] and in the SSR-RSC payload from /u/[id]) because
  // the active/lifetime delta would let a snooper compute how many
  // sessions the profile owner has had deleted.
  activeRatings?: number
  // Coarse "has at least one active scored rating" — surfaced to BOTH
  // owner and non-owner. Lets the empty-state on the Ratings tab tell
  // "never tasted any flavours" / "tasted but no chip data yet" /
  // "all rated wines have been deleted" apart without leaking the
  // exact active count to non-owners.
  hasActiveRatings: boolean
  // Average score across active ratings. null if no rows.
  avgScore: number | null
  fiveStar: number
  // Score-weighted mean per flavor key. null when the user has no rating
  // that contributed any value for that key.
  keys: Record<string, number | null>
}

// Computes the flavor-wheel aggregate over a user's `ratings` rows. Used
// by the public `/api/users/[id]` endpoint and the server-rendered
// `/u/[id]` page so both surfaces show the same numbers without a
// duplicate roundtrip.
export async function getProfileFlavor(userId: number): Promise<FlavorBlock> {
  const weightedAvg = FL_KEYS.map(f =>
    `ROUND((SUM((flavors->>'${f}')::numeric * score) / NULLIF(SUM(CASE WHEN (flavors->>'${f}')::numeric > 0 THEN score ELSE 0 END), 0))::numeric, 2) AS ${f}`,
  ).join(', ')
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${weightedAvg},
            COUNT(*) AS total_rated,
            ROUND(AVG(score)::numeric, 1) AS avg_score,
            COUNT(CASE WHEN score = 5.00 THEN 1 END) AS five_star
     FROM ratings WHERE user_id = $1 AND score > 0`,
    userId,
  )
  const row = rows[0] || {}
  const keys: Record<string, number | null> = {}
  for (const k of FL_KEYS) {
    const v = row[k]
    keys[k] = v == null ? null : Number(v)
  }
  const activeRatings = Number(row.total_rated || 0)
  return {
    activeRatings,
    hasActiveRatings: activeRatings > 0,
    avgScore: row.avg_score == null ? null : Number(row.avg_score),
    fiveStar: Number(row.five_star || 0),
    keys,
  }
}
