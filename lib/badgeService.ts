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
    const count = await prisma.badge.count()
    // Re-seed whenever the DB count is behind the code definition (e.g. new badges added)
    if (count < ALL_BADGES.length) {
      await prisma.badge.createMany({
        data: ALL_BADGES.map(b => ({
          id: b.id, name: b.name, description: b.description,
          icon: b.icon, category: b.category, rarity: b.rarity, xpReward: b.xp_reward,
        })),
        skipDuplicates: true,
      })
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
  const snap = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      lifetimeRatings: true, lifetimeFiveStar: true, lifetimeOneStar: true,
      lifetimeNotesWritten: true, lifetimeMaxNoteLength: true,
      lifetimeSessionsJoined: true, lifetimeSessionsHosted: true,
      lifetimePhotosAdded: true, lifetimeConsecutiveMonths: true,
      firstRatedAt: true,
    },
  })

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

  const [bookmarkCount, hofEntries] = await Promise.all([
    prisma.bookmark.count({ where: { userId } }),
    prisma.hallOfFame.count({ where: { userId } }),
  ])

  // daysSinceFirst is derived from the snapshotted firstRatedAt — never
  // shrinks, even if the original first rating gets deleted later.
  const daysSinceFirst = snap?.firstRatedAt
    ? Math.floor((Date.now() - new Date(snap.firstRatedAt).getTime()) / 86400000)
    : 0

  return {
    totalRatings:        snap?.lifetimeRatings ?? 0,
    fiveStarCount:       snap?.lifetimeFiveStar ?? 0,
    oneStarCount:        snap?.lifetimeOneStar ?? 0,
    notesWritten:        snap?.lifetimeNotesWritten ?? 0,
    maxNoteLength:       snap?.lifetimeMaxNoteLength ?? 0,
    daysSinceFirst,
    consecutiveMonths:   snap?.lifetimeConsecutiveMonths ?? 0,
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
    totalSessions:       snap?.lifetimeSessionsJoined ?? 0,
    sessionsHosted:      snap?.lifetimeSessionsHosted ?? 0,
    sessionParticipants: Number(soc.max_participants),
    bookmarkCount,
    hofEntries,
    photosAdded:         snap?.lifetimePhotosAdded ?? 0,
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
    prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true } }),
  ])

  const alreadyEarned = new Set(existing.map(b => b.badgeId))
  const newBadgeIds = evaluateBadges(stats, alreadyEarned)

  if (newBadgeIds.length > 0) {
    // Insert individually so a missing badge FK (shouldn't happen after seed fix)
    // doesn't abort the entire batch and lose all XP
    for (const badgeId of newBadgeIds) {
      try {
        await prisma.userBadge.create({ data: { userId, badgeId, seen: false } })
        const badge = BADGE_MAP[badgeId]
        if (badge) xpGain += badge.xp_reward
      } catch { /* duplicate or missing badge — skip */ }
    }
  }

  let totalXP = 0
  if (xpGain > 0) {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { xp: { increment: xpGain } },
      select: { xp: true },
    })
    totalXP = updated.xp
  } else {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { xp: true } })
    totalXP = u?.xp ?? 0
  }

  return {
    newBadges: newBadgeIds.map(id => BADGE_MAP[id]).filter(Boolean) as typeof ALL_BADGES,
    xpGained: xpGain,
    totalXP,
  }
}
