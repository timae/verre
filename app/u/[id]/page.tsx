import { auth } from '@/auth'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { ProfileTabs } from '@/components/profile/ProfileTabs'
import { FollowButton } from '@/components/social/FollowButton'
import { ProfileSettingsButton } from '@/components/profile/ProfileSettingsButton'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { getProfileFlavor } from '@/lib/profileFlavor'
import { parsePathId } from '@/lib/parsePathId'
import Link from 'next/link'

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  const myId = session?.user ? Number(session.user.id) : null
  const parsedId = parsePathId(id)
  if (parsedId === null) notFound()
  const userId = parsedId

  const gate = await resolveProfileViewer(userId, myId)
  if (gate.status === 'gone') notFound()
  const isFollowing = gate.viewer.followsProfile

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, xp: true,
      lifetimeRatings: true, lifetimeSessionsJoined: true,
      _count: { select: { earnedBadges: true, checkins: { where: { isPublic: true } }, followers: true, following: true } },
    },
  })
  if (!user) notFound()

  const [checkins, flavorFull] = await Promise.all([
    prisma.checkin.findMany({
      where: { userId, isPublic: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        _count: { select: { likes: true } },
        tags: { include: { user: { select: { id: true, name: true } } } },
      },
    }),
    getProfileFlavor(userId),
  ])

  // Hydrate the viewer's "liked" state per checkin so the heart matches
  // the feed's behavior. Skipped for anon viewers — no caller, no
  // possible like rows. One round-trip for the page-load batch.
  const likedSet = myId
    ? new Set(
        (await prisma.checkinLike.findMany({
          where: { userId: myId, checkinId: { in: checkins.map(c => c.id) } },
          select: { checkinId: true },
        })).map(l => l.checkinId),
      )
    : new Set<number>()

  // Mirror the API redaction in the RSC payload — `'use client'` props
  // get serialised into the page's __next_f and any non-owner viewer
  // could read `flavor.activeRatings` from devtools, defeating the API
  // response stripping in /api/users/[id]. Same redaction policy as the
  // route: keep activeRatings owner-only, ship the wheel data to all.
  const isOwner = myId === userId
  const flavor = isOwner
    ? flavorFull
    : { avgScore: flavorFull.avgScore, fiveStar: flavorFull.fiveStar, keys: flavorFull.keys }

  const level = getLevel(user.xp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((user.xp - level.minXP) / (nextXP - level.minXP)) * 100 : 100

  return (
    <div className="app-bg" style={{ minHeight: '100vh', padding: '0 0 40px' }}>
      <header style={{ padding: '0 16px', height: 'var(--hdr-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(14,14,12,0.82)', backdropFilter: 'blur(18px)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link href={session?.user ? '/me' : '/'} style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}>Verre</Link>
      </header>

      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 16px 0' }}>
        {/* Profile header — server-rendered; stays put across tab switches. */}
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(200,150,60,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>
              {user.name[0].toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 }}>{user.name}</h1>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{level.icon} {level.name} · {user.xp.toLocaleString()} XP</div>
              <div style={{ height: 3, background: 'var(--bg3)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, progress)}%`, background: 'var(--accent)', borderRadius: 2 }} />
              </div>
            </div>
            {myId === userId ? (
              <ProfileSettingsButton />
            ) : myId ? (
              <FollowButton userId={userId} initialFollowing={isFollowing} />
            ) : null}
          </div>
        </div>

        <ProfileTabs
          profileUserId={userId}
          profileUserName={user.name}
          profileUserXp={user.xp}
          myId={myId}
          viewerFollowsProfile={isFollowing}
          stats={{
            ratings: user.lifetimeRatings,
            checkins: user._count.checkins,
            badges: user._count.earnedBadges,
            followers: user._count.followers,
          }}
          flavor={flavor}
          initialCheckins={checkins.map(c => ({
            id: c.id, wineName: c.wineName, producer: c.producer, vintage: c.vintage,
            grape: c.grape, type: c.type, score: c.score == null ? null : Number(c.score), notes: c.notes, imageUrl: c.imageUrl,
            venueName: c.venueName, city: c.city, country: c.country,
            flavors: c.flavors as Record<string, number>, likeCount: c._count.likes,
            liked: likedSet.has(c.id),
            createdAt: c.createdAt,
            tags: c.tags?.map(t => t.user) ?? [],
          }))}
        />
      </div>
    </div>
  )
}
