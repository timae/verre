import { auth } from '@/auth'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { ProfileTabs } from '@/components/profile/ProfileTabs'
import { ProfileHeader } from '@/components/profile/ProfileHeader'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { getProfileFlavor } from '@/lib/profileFlavor'
import { parsePathId } from '@/lib/parsePathId'
import { ThemeToggle } from '@/components/ThemeToggle'
import { UserMenu } from '@/components/me/UserMenu'
import { MeNav, MeSidebar } from '@/components/me/MeNav'
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

  // Profile content. Logged-in viewers get the `/me/*` chrome (sidebar
  // + bottom nav + UserMenu) so navigation stays consistent when
  // bouncing between /me/feed and /u/<id>. Anonymous viewers get a
  // bare header with just the brand. The outer wrappers below add
  // the page padding + max-width — `profileBody` itself is unwrapped
  // so it slots into either path without double-padding.
  const profileBody = (
    <>
        <ProfileHeader
          userId={userId}
          userName={user.name}
          userXp={user.xp}
          myId={myId}
          isFollowing={isFollowing}
        />

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
    </>
  )

  // Logged-in viewer: render inside the same chrome as /me/* (sidebar
  // + bottom nav + UserMenu). Mirrors app/me/layout.tsx structure.
  if (session?.user) {
    const viewerPro = !!(session.user as { pro?: boolean }).pro
    return (
      <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
        <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',position:'sticky',top:0,zIndex:10,flexShrink:0}}>
          <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <ThemeToggle />
            <UserMenu myId={myId!} name={session.user.name} email={session.user.email} pro={viewerPro} />
          </div>
        </header>
        <div style={{flex:1,display:'flex',overflow:'hidden'}}>
          <aside style={{width:180,flexShrink:0,borderRight:'1px solid rgba(255,255,255,0.04)',padding:'16px 8px',display:'flex',flexDirection:'column',gap:2,overflowY:'auto'}} className="me-sidebar">
            <MeSidebar myId={myId!} />
          </aside>
          <main style={{flex:1,overflowY:'auto',padding:'16px 20px 100px'}}>
            <div style={{maxWidth:860,margin:'0 auto'}}>
              {profileBody}
            </div>
          </main>
        </div>
        <div className="me-bottom-nav">
          <MeNav myId={myId!} />
        </div>
      </div>
    )
  }

  // Anonymous viewer: bare brand header, no nav.
  return (
    <div className="app-bg" style={{ minHeight: '100vh', padding: '0 0 40px' }}>
      <header style={{ padding: '0 16px', height: 'var(--hdr-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(14,14,12,0.82)', backdropFilter: 'blur(18px)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link href="/" style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}>Verre</Link>
      </header>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 16px 0' }}>
        {profileBody}
      </div>
    </div>
  )
}
