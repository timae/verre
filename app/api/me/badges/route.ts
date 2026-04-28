import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { ALL_BADGES, BADGE_MAP, evaluateBadges, XP_REWARDS, type UserStats } from '@/lib/badges'

// Ensure badge definitions are seeded
async function seedBadges() {
  const existing = await prisma.$queryRaw<{id:string}[]>`SELECT id FROM badges`
  const existingIds = new Set(existing.map(b => b.id))
  const toInsert = ALL_BADGES.filter(b => !existingIds.has(b.id))
  if (toInsert.length === 0) return
  for (const b of toInsert) {
    await prisma.$executeRaw`
      INSERT INTO badges (id, name, description, icon, category, rarity, xp_reward)
      VALUES (${b.id}, ${b.name}, ${b.description}, ${b.icon}, ${b.category}, ${b.rarity}, ${b.xp_reward})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function getUserStats(userId: number): Promise<UserStats> {
  const [main] = await prisma.$queryRaw<[{
    total_ratings: bigint; five_star: bigint; one_star: bigint
    notes_written: bigint; photos_added: bigint
    red_count: bigint; white_count: bigint; spark_count: bigint
    rose_count: bigint; nonalc_count: bigint
    unique_styles: bigint; unique_grapes: bigint
    avg_score: number | null; avg_tannin: number | null; avg_acid: number | null
    avg_oak: number | null; avg_floral: number | null; avg_earth: number | null
    avg_fruit: number | null; max_note_len: bigint
    days_since_first: number | null; consecutive_months: bigint
  }]>`
    SELECT
      COUNT(*) AS total_ratings,
      COUNT(*) FILTER (WHERE score = 5) AS five_star,
      COUNT(*) FILTER (WHERE score = 1) AS one_star,
      COUNT(*) FILTER (WHERE notes IS NOT NULL AND LENGTH(notes) > 5) AS notes_written,
      COALESCE(MAX(LENGTH(notes)), 0) AS max_note_len,
      EXTRACT(DAY FROM NOW() - MIN(rated_at)) AS days_since_first,
      COUNT(DISTINCT DATE_TRUNC('month', rated_at)) AS consecutive_months,
      AVG(score) AS avg_score,
      AVG((flavors->>'tannin')::numeric) FILTER (WHERE flavors->>'tannin' IS NOT NULL) AS avg_tannin,
      AVG((flavors->>'acid')::numeric) FILTER (WHERE flavors->>'acid' IS NOT NULL) AS avg_acid,
      AVG((flavors->>'oak')::numeric) FILTER (WHERE flavors->>'oak' IS NOT NULL) AS avg_oak,
      AVG((flavors->>'floral')::numeric) FILTER (WHERE flavors->>'floral' IS NOT NULL) AS avg_floral,
      AVG((flavors->>'earth')::numeric) FILTER (WHERE flavors->>'earth' IS NOT NULL) AS avg_earth,
      AVG(COALESCE((flavors->>'citrus')::numeric,0) + COALESCE((flavors->>'stone')::numeric,0) + COALESCE((flavors->>'tropical')::numeric,0) + COALESCE((flavors->>'red_fruit')::numeric,0) + COALESCE((flavors->>'dark_fruit')::numeric,0)) AS avg_fruit
    FROM ratings r
    JOIN wines w ON w.id = r.wine_id
    WHERE r.user_id = ${userId}
  `

  const [typeCounts] = await prisma.$queryRaw<[{
    red_count: bigint; white_count: bigint; spark_count: bigint
    rose_count: bigint; nonalc_count: bigint; unique_styles: bigint; unique_grapes: bigint
  }]>`
    SELECT
      COUNT(*) FILTER (WHERE w.style IN ('red','Red')) AS red_count,
      COUNT(*) FILTER (WHERE w.style IN ('white','White')) AS white_count,
      COUNT(*) FILTER (WHERE w.style IN ('spark','Sparkling','Bubbles')) AS spark_count,
      COUNT(*) FILTER (WHERE w.style IN ('rose','Rosé')) AS rose_count,
      COUNT(*) FILTER (WHERE w.style IN ('nonalc','Non-Alc')) AS nonalc_count,
      COUNT(DISTINCT LOWER(w.style)) FILTER (WHERE w.style IS NOT NULL) AS unique_styles,
      COUNT(DISTINCT LOWER(w.grape)) FILTER (WHERE w.grape IS NOT NULL AND w.grape != '') AS unique_grapes
    FROM ratings r
    JOIN wines w ON w.id = r.wine_id
    WHERE r.user_id = ${userId}
  `

  const [socials] = await prisma.$queryRaw<[{ total_sessions: bigint; hosted: bigint; max_participants: bigint }]>`
    SELECT
      COUNT(DISTINCT sm.session_code) AS total_sessions,
      COUNT(DISTINCT s.id) FILTER (WHERE s.host_user_id = ${userId}) AS hosted,
      COALESCE(MAX(member_counts.cnt), 1) AS max_participants
    FROM session_members sm
    LEFT JOIN sessions s ON s.code = sm.session_code
    LEFT JOIN (
      SELECT session_code, COUNT(*) AS cnt FROM session_members GROUP BY session_code
    ) member_counts ON member_counts.session_code = sm.session_code
    WHERE sm.user_id = ${userId}
  `

  const [bookmarks] = await prisma.$queryRaw<[{ cnt: bigint }]>`SELECT COUNT(*) AS cnt FROM bookmarks WHERE user_id = ${userId}`
  const [hof] = await prisma.$queryRaw<[{ cnt: bigint }]>`SELECT COUNT(*) AS cnt FROM hall_of_fame WHERE user_id = ${userId}`
  const [photos] = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(DISTINCT r.wine_id) AS cnt FROM ratings r JOIN wines w ON w.id = r.wine_id WHERE r.user_id = ${userId} AND w.image_url IS NOT NULL`

  return {
    totalRatings: Number(main.total_ratings),
    fiveStarCount: Number(main.five_star),
    oneStarCount: Number(main.one_star),
    notesWritten: Number(main.notes_written),
    maxNoteLength: Number(main.max_note_len),
    daysSinceFirst: Math.floor(Number(main.days_since_first) || 0),
    consecutiveMonths: Number(main.consecutive_months),
    avgScore: Number(main.avg_score) || 0,
    avgFlavorTannin: Number(main.avg_tannin) || 0,
    avgFlavorAcid: Number(main.avg_acid) || 0,
    avgFlavorOak: Number(main.avg_oak) || 0,
    avgFlavorFloral: Number(main.avg_floral) || 0,
    avgFlavorEarth: Number(main.avg_earth) || 0,
    avgFlavorFruit: Number(main.avg_fruit) || 0,
    redCount: Number(typeCounts.red_count),
    whiteCount: Number(typeCounts.white_count),
    sparkCount: Number(typeCounts.spark_count),
    roseCount: Number(typeCounts.rose_count),
    nonalcCount: Number(typeCounts.nonalc_count),
    uniqueStyles: Number(typeCounts.unique_styles),
    uniqueGrapes: Number(typeCounts.unique_grapes),
    totalSessions: Number(socials.total_sessions),
    sessionsHosted: Number(socials.hosted),
    sessionParticipants: Number(socials.max_participants),
    bookmarkCount: Number(bookmarks.cnt),
    hofEntries: Number(hof.cnt),
    photosAdded: Number(photos.cnt),
    aiScansUsed: 0,
  }
}

// GET — return all badges with earned status
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  await seedBadges()

  const earned = await prisma.$queryRaw<{ badge_id: string; earned_at: Date; seen: boolean }[]>`
    SELECT badge_id, earned_at, seen FROM user_badges WHERE user_id = ${userId} ORDER BY earned_at DESC`

  const earnedMap = Object.fromEntries(earned.map(e => [e.badge_id, e]))
  const [user] = await prisma.$queryRaw<[{ xp: number }]>`SELECT xp FROM users WHERE id = ${userId}`

  return NextResponse.json({
    badges: ALL_BADGES.map(b => ({ ...b, earned: !!earnedMap[b.id], earned_at: earnedMap[b.id]?.earned_at || null, seen: earnedMap[b.id]?.seen ?? true })),
    xp: user.xp,
    unseenCount: earned.filter(e => !e.seen).length,
  })
}

// POST — check and award new badges, add XP
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const { action } = await req.json().catch(() => ({ action: '' }))

  await seedBadges()

  // Award XP for the action
  let xpGain = 0
  if (action === 'rate') xpGain = XP_REWARDS.RATE_WINE
  if (action === 'rate_with_note') xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.WRITE_NOTE
  if (action === 'rate_5star') xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.GIVE_5_STAR
  if (action === 'rate_5star_note') xpGain = XP_REWARDS.RATE_WINE + XP_REWARDS.GIVE_5_STAR + XP_REWARDS.WRITE_NOTE
  if (action === 'host') xpGain = XP_REWARDS.HOST_SESSION
  if (action === 'join') xpGain = XP_REWARDS.JOIN_SESSION
  if (action === 'bookmark') xpGain = XP_REWARDS.BOOKMARK
  if (action === 'photo') xpGain = XP_REWARDS.ADD_PHOTO

  // Compute stats & evaluate badges
  const stats = await getUserStats(userId)
  const existingBadges = await prisma.$queryRaw<{badge_id: string}[]>`SELECT badge_id FROM user_badges WHERE user_id = ${userId}`
  const alreadyEarned = new Set(existingBadges.map(b => b.badge_id))
  const newBadgeIds = evaluateBadges(stats, alreadyEarned)

  // Award new badges and their XP
  for (const badgeId of newBadgeIds) {
    const badge = BADGE_MAP[badgeId]
    if (!badge) continue
    await prisma.$executeRaw`INSERT INTO user_badges (user_id, badge_id, seen) VALUES (${userId}, ${badgeId}, false) ON CONFLICT DO NOTHING`
    xpGain += badge.xp_reward
  }

  // Update user XP
  if (xpGain > 0) {
    await prisma.$executeRaw`UPDATE users SET xp = xp + ${xpGain} WHERE id = ${userId}`
  }

  const [user] = await prisma.$queryRaw<[{ xp: number }]>`SELECT xp FROM users WHERE id = ${userId}`

  return NextResponse.json({
    newBadges: newBadgeIds.map(id => BADGE_MAP[id]).filter(Boolean),
    xpGained: xpGain,
    totalXP: user.xp,
  })
}

// PATCH — mark badges as seen
export async function PATCH() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  await prisma.$executeRaw`UPDATE user_badges SET seen = true WHERE user_id = ${userId}`
  return NextResponse.json({ ok: true })
}
