import { auth } from '@/auth'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { CheckinCard } from '@/components/social/CheckinCard'
import { FollowButton } from '@/components/social/FollowButton'
import Link from 'next/link'

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  const myId = session?.user ? Number(session.user.id) : null
  const userId = Number(id)
  if (isNaN(userId)) notFound()

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, xp: true,
      lifetimeRatings: true, lifetimeSessionsJoined: true,
      _count: { select: { earnedBadges: true, checkins: { where: { isPublic: true } }, followers: true, following: true } },
    },
  })
  if (!user) notFound()

  const isFollowing = myId && myId !== userId
    ? !!(await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: myId, followingId: userId } } }))
    : false

  const checkins = await prisma.checkin.findMany({
    where: { userId, isPublic: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { _count: { select: { likes: true } } },
  })

  const level = getLevel(user.xp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((user.xp - level.minXP) / (nextXP - level.minXP)) * 100 : 100

  return (
    <div className="app-bg" style={{ minHeight: '100vh', padding: '0 0 40px' }}>
      <header style={{ padding: '0 16px', height: 'var(--hdr-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(14,14,12,0.82)', backdropFilter: 'blur(18px)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link href="/me" style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}>Verre</Link>
      </header>

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 16px 0' }}>
        {/* Profile header */}
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
            {myId && myId !== userId && (
              <FollowButton userId={userId} initialFollowing={isFollowing} />
            )}
          </div>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { label: 'ratings', value: user.lifetimeRatings },
              { label: 'check-ins', value: user._count.checkins },
              { label: 'badges', value: user._count.earnedBadges },
              { label: 'followers', value: user._count.followers },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: 'center', padding: '8px 4px', background: 'var(--bg3)', borderRadius: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 9, color: 'var(--fg-dim)', marginTop: 2, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Check-ins */}
        <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 10 }}>// check-ins</div>
        {checkins.length === 0 && (
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, padding: '16px 0' }}>No public check-ins yet.</p>
        )}
        {checkins.map(c => (
          <CheckinCard
            key={c.id}
            checkin={{ id: c.id, wineName: c.wineName, producer: c.producer, vintage: c.vintage, type: c.type, score: c.score, notes: c.notes, imageUrl: c.imageUrl, venueName: c.venueName, city: c.city, country: c.country, flavors: c.flavors as Record<string, number>, likeCount: c._count.likes }}
            showAuthor={false}
          />
        ))}
      </div>
    </div>
  )
}
