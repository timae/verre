/**
 * Badge service — called directly (not via HTTP) from rate/session routes.
 * Runs stats query, evaluates badge criteria, awards new badges, updates XP.
 */
import { prisma } from '@/lib/prisma'
import { ALL_BADGES, BADGE_MAP, evaluateBadges, XP_REWARDS, type UserStats } from '@/lib/badges'

// ── Seed ─────────────────────────────────────────────────────
let seeded = false
export async function ensureBadgesSeedOnce() {
  if (seeded) return
  try {
    const existing = await prisma.$queryRaw<{id:string}[]>`SELECT id FROM badges LIMIT 1`
    if (existing.length === 0) {
      // Batch insert all badges in one statement
      const vals = ALL_BADGES.map(b =>
        `(${[b.id,b.name,b.description,b.icon,b.category,b.rarity,b.xp_reward].map((v,i) => i === 6 ? v : `'${String(v).replace(/'/g,"''")}'`).join(',')})`
      ).join(',')
      await prisma.$executeRawUnsafe(
        `INSERT INTO badges (id,name,description,icon,category,rarity,xp_reward) VALUES ${vals} ON CONFLICT (id) DO NOTHING`
      )
    }
    seeded = true
  } catch {}
}

// ── Stats ─────────────────────────────────────────────────────
//
// Mixes O(1) snapshot reads from `users` (counters that drive badges and
// don't tolerate going down) with live aggregations for the per-style/grape
// counts and averages (only rendered on /me/profile, low frequency, and
// not used to award badges). The hot path — every rate POST — only reads
// the snapshot row and one count of bookmarks/HoF.
export async function getUserStats(userId: number): Promise<UserStats> {
  // Snapshot — single primary-key lookup.
  const [snap] = await prisma.$queryRaw<[{
    lifetime_ratings:number; lifetime_five_star:number; lifetime_one_star:number
    lifetime_notes_written:number; lifetime_max_note_len:number
    lifetime_sessions_joined:number; lifetime_sessions_hosted:number
    lifetime_photos_added:number; lifetime_consecutive_months:number
    first_rated_at:Date|null
  }]>`
    SELECT lifetime_ratings, lifetime_five_star, lifetime_one_star,
           lifetime_notes_written, lifetime_max_note_len,
           lifetime_sessions_joined, lifetime_sessions_hosted,
           lifetime_photos_added, lifetime_consecutive_months,
           first_rated_at
    FROM users WHERE id=${userId}`

  // Live — rendered on /me/profile only. Aggregates against ratings table.
  // Acceptable because /me/profile loads are infrequent compared to rate
  // POSTs. If profile rendering shows up in profiling later, snapshot
  // these too.
  const [main] = await prisma.$queryRaw<[{
    avg_score:number|null; avg_tannin:number|null; avg_acid:number|null
    avg_oak:number|null; avg_floral:number|null; avg_earth:number|null; avg_fruit:number|null
  }]>`
    SELECT
      AVG(score)::float AS avg_score,
      AVG((flavors->>'tannin')::numeric) FILTER (WHERE (flavors->>'tannin') IS NOT NULL)::float AS avg_tannin,
      AVG((flavors->>'acid')::numeric)   FILTER (WHERE (flavors->>'acid')   IS NOT NULL)::float AS avg_acid,
      AVG((flavors->>'oak')::numeric)    FILTER (WHERE (flavors->>'oak')    IS NOT NULL)::float AS avg_oak,
      AVG((flavors->>'floral')::numeric) FILTER (WHERE (flavors->>'floral') IS NOT NULL)::float AS avg_floral,
      AVG((flavors->>'earth')::numeric)  FILTER (WHERE (flavors->>'earth')  IS NOT NULL)::float AS avg_earth,
      AVG(COALESCE((flavors->>'citrus')::numeric,0)+COALESCE((flavors->>'stone')::numeric,0)+COALESCE((flavors->>'tropical')::numeric,0)+COALESCE((flavors->>'red_fruit')::numeric,0)+COALESCE((flavors->>'dark_fruit')::numeric,0))::float AS avg_fruit
    FROM ratings WHERE user_id=${userId}`

  const [types] = await prisma.$queryRaw<[{
    red_count:bigint; white_count:bigint; spark_count:bigint; rose_count:bigint
    nonalc_count:bigint; unique_styles:bigint; unique_grapes:bigint
  }]>`
    SELECT
      COUNT(*) FILTER (WHERE w.style='red')    AS red_count,
      COUNT(*) FILTER (WHERE w.style='white')  AS white_count,
      COUNT(*) FILTER (WHERE w.style='spark')  AS spark_count,
      COUNT(*) FILTER (WHERE w.style='rose')   AS rose_count,
      COUNT(*) FILTER (WHERE w.style='nonalc') AS nonalc_count,
      COUNT(DISTINCT LOWER(w.style))  FILTER (WHERE w.style IS NOT NULL) AS unique_styles,
      COUNT(DISTINCT LOWER(w.grape))  FILTER (WHERE w.grape IS NOT NULL AND w.grape<>'') AS unique_grapes
    FROM ratings r JOIN wines w ON w.id=r.wine_id WHERE r.user_id=${userId}`

  // Max participants from any session this user is in. Live; would be a
  // candidate for snapshot if it shows up in profiling.
  const [soc] = await prisma.$queryRaw<[{max_participants:bigint}]>`
    SELECT COALESCE(MAX(mc.cnt),1) AS max_participants
    FROM session_members sm
    LEFT JOIN (SELECT session_code, COUNT(*) AS cnt FROM session_members GROUP BY session_code) mc ON mc.session_code=sm.session_code
    WHERE sm.user_id=${userId}`

  const [bk]  = await prisma.$queryRaw<[{cnt:bigint}]>`SELECT COUNT(*) AS cnt FROM bookmarks WHERE user_id=${userId}`
  const [hof] = await prisma.$queryRaw<[{cnt:bigint}]>`SELECT COUNT(*) AS cnt FROM hall_of_fame WHERE user_id=${userId}`

  // daysSinceFirst is derived from the snapshotted firstRatedAt — never
  // shrinks, even if the original first rating gets deleted later.
  const daysSinceFirst = snap?.first_rated_at
    ? Math.floor((Date.now() - new Date(snap.first_rated_at).getTime()) / 86400000)
    : 0

  return {
    totalRatings:        Number(snap?.lifetime_ratings || 0),
    fiveStarCount:       Number(snap?.lifetime_five_star || 0),
    oneStarCount:        Number(snap?.lifetime_one_star || 0),
    notesWritten:        Number(snap?.lifetime_notes_written || 0),
    maxNoteLength:       Number(snap?.lifetime_max_note_len || 0),
    daysSinceFirst,
    consecutiveMonths:   Number(snap?.lifetime_consecutive_months || 0),
    avgScore:            Number(main.avg_score) || 0,
    avgFlavorTannin:     Number(main.avg_tannin) || 0,
    avgFlavorAcid:       Number(main.avg_acid) || 0,
    avgFlavorOak:        Number(main.avg_oak) || 0,
    avgFlavorFloral:     Number(main.avg_floral) || 0,
    avgFlavorEarth:      Number(main.avg_earth) || 0,
    avgFlavorFruit:      Number(main.avg_fruit) || 0,
    redCount:            Number(types.red_count),
    whiteCount:          Number(types.white_count),
    sparkCount:          Number(types.spark_count),
    roseCount:           Number(types.rose_count),
    nonalcCount:         Number(types.nonalc_count),
    uniqueStyles:        Number(types.unique_styles),
    uniqueGrapes:        Number(types.unique_grapes),
    totalSessions:       Number(snap?.lifetime_sessions_joined || 0),
    sessionsHosted:      Number(snap?.lifetime_sessions_hosted || 0),
    sessionParticipants: Number(soc.max_participants),
    bookmarkCount:       Number(bk.cnt),
    hofEntries:          Number(hof.cnt),
    photosAdded:         Number(snap?.lifetime_photos_added || 0),
    aiScansUsed:         0,
  }
}

// ── Award ─────────────────────────────────────────────────────
export async function checkAndAwardBadges(userId: number, action: string): Promise<{newBadges: typeof ALL_BADGES; xpGained: number; totalXP: number}> {
  await ensureBadgesSeedOnce()

  let xpGain = 0
  if (action === 'rate')           xpGain = XP_REWARDS.RATE_WINE
  if (action === 'rate_with_note') xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.WRITE_NOTE
  if (action === 'rate_5star')     xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.GIVE_5_STAR
  if (action === 'rate_5star_note')xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.GIVE_5_STAR + XP_REWARDS.WRITE_NOTE
  if (action === 'host')           xpGain = XP_REWARDS.HOST_SESSION
  if (action === 'join')           xpGain = XP_REWARDS.JOIN_SESSION
  if (action === 'bookmark')       xpGain = XP_REWARDS.BOOKMARK
  if (action === 'photo')          xpGain = XP_REWARDS.ADD_PHOTO

  const [stats, existing] = await Promise.all([
    getUserStats(userId),
    prisma.$queryRaw<{badge_id:string}[]>`SELECT badge_id FROM user_badges WHERE user_id=${userId}`,
  ])

  const alreadyEarned = new Set(existing.map(b => b.badge_id))
  const newBadgeIds = evaluateBadges(stats, alreadyEarned)

  for (const badgeId of newBadgeIds) {
    const badge = BADGE_MAP[badgeId]
    if (!badge) continue
    await prisma.$executeRaw`INSERT INTO user_badges (user_id,badge_id,seen) VALUES (${userId},${badgeId},false) ON CONFLICT DO NOTHING`
    xpGain += badge.xp_reward
  }

  if (xpGain > 0) {
    await prisma.$executeRaw`UPDATE users SET xp=xp+${xpGain} WHERE id=${userId}`
  }

  const [user] = await prisma.$queryRaw<[{xp:number}]>`SELECT xp FROM users WHERE id=${userId}`

  return {
    newBadges: newBadgeIds.map(id => BADGE_MAP[id]).filter(Boolean) as typeof ALL_BADGES,
    xpGained: xpGain,
    totalXP: Number(user.xp),
  }
}
