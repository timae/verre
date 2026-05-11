import { auth } from '@/auth'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { ProfileTabs } from '@/components/profile/ProfileTabs'
import { ProfileHeader } from '@/components/profile/ProfileHeader'
import { ProfileShell } from '@/components/profile/ProfileShell'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { loadProfile } from '@/lib/profileLoad'
import { parsePathId } from '@/lib/parsePathId'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'
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

  // Mirror the per-IP cap on /api/users/[id] — without it, the SSR path
  // is the cheap enumeration channel an attacker would take to walk the
  // user-id space and read display names.
  const hdr = await headers()
  const ip = hdr.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile:${ip}:1m`, 60, 60)
  if (!rl.allowed) notFound()

  const gate = await resolveProfileViewer(userId, myId)
  if (gate.status === 'gone') notFound()

  // Tier-gated viewers see a shell: display name + dummy avatar + follow
  // button. The user is findable but their content (XP, badges, check-ins,
  // social graph) stays hidden until the gate flips. Avatar is part of
  // the gated content — never include the imageUrl in the shell.
  let profileBody: React.ReactNode
  if (gate.status === 'shell') {
    // Hydrate `isFollowing` so the follow button reflects current state
    // for logged-in viewers. The follow lookup is the only DB call here
    // — name comes from the gate result.
    const isFollowing = myId
      ? !!(await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: myId, followingId: userId } },
          select: { followerId: true },
        }))
      : false
    profileBody = (
      <ProfileShell
        userId={userId}
        userName={gate.name}
        myId={myId}
        isFollowing={isFollowing}
      />
    )
  } else {
    // Same loader the API route uses — single source for the payload
    // shape. SSR calls Prisma directly; the API call goes over the wire.
    const profile = await loadProfile({ userId, viewerId: myId, isFollowing: gate.viewer.followsProfile })
    if (!profile) notFound()
    profileBody = (
      <>
          <ProfileHeader
            userId={profile.id}
            userName={profile.name}
            userXp={profile.xp}
            userImageUrl={profile.imageUrl}
            myId={myId}
            isFollowing={profile.isFollowing}
          />

          <ProfileTabs
            profileUserId={profile.id}
            profileUserName={profile.name}
            profileUserXp={profile.xp}
            profileUserImageUrl={profile.imageUrl}
            myId={myId}
            viewerFollowsProfile={profile.isFollowing}
            stats={{
              ratings: profile.stats.ratings,
              checkins: profile.stats.checkins,
              badges: profile.stats.badges,
              followers: profile.stats.followers,
            }}
            flavor={profile.flavor}
            initialCheckins={profile.recentCheckins.map(c => ({
              ...c,
              flavors: c.flavors as Record<string, number>,
            }))}
          />
      </>
    )
  }

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
