import { prisma } from '@/lib/prisma'
import { resolveAxes } from '@/lib/flavours'

// Profile-aggregate keys = the STRUCTURE axes (no longer hardcoded descriptors).
// Derived from the registry so this can't drift from the axis set — the
// "second hardcoded list" that broke the day descriptors were dropped (§6a) is
// gone. The base wine set (resolveAxes('wine','red')) is the 7 universal wine
// axes; `bubbles` (sparkling-only) is intentionally excluded — the profile
// wheel is a cross-wine structure profile, not a per-style one.
//
// Strict regex (kept): these names are interpolated raw into a SQL SELECT list
// (column aliases + JSON path keys). The registry only ever produces lowercase
// snake keys, but the guard stays as a hard backstop against any future axis
// key that isn't injection-safe.
//
// Mixed-history caveat (§6a / §10 #4, deferred): a user with pre-migration rows
// (only body/acid/tannin/sweet survive) + new structure rows will have the new
// axes (finish/aroma/flavour) averaged over fewer rows than the carried-over
// ones. The blend is accepted for now; per-axis n / post-migration-only is a
// later product call.
export const FL_KEYS = resolveAxes('wine', 'red').map(a => a.k)

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
  // Score-weighted mean per axis. Keyed on key-PRESENCE (`flavors ? '${f}'`),
  // NOT `> 0`: under the structure-wheel zero rule (§5) a present 0 means "rated
  // None" — a real judgment that must pull the average toward 0, not be excluded
  // as "not rated". A row that never rated this axis (key absent) still
  // contributes nothing (absent → not in numerator or denominator). NULLIF keeps
  // an all-absent axis at NULL (→ "never tasted that dimension"), not 0.
  const weightedAvg = FL_KEYS.map(f =>
    `ROUND((SUM((flavors->>'${f}')::numeric * score) FILTER (WHERE flavors ? '${f}') / NULLIF(SUM(score) FILTER (WHERE flavors ? '${f}'), 0))::numeric, 2) AS ${f}`,
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
