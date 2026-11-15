import { auth } from '@/auth'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { ProfileTabs } from '@/components/profile/ProfileTabs'
import { ProfileHeader } from '@/components/profile/ProfileHeader'
import { ProfileShell } from '@/components/profile/ProfileShell'
import { ProfileBlockedView } from '@/components/profile/ProfileBlockedView'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { loadProfile } from '@/lib/profileLoad'
import { isMuted } from '@/lib/userMute'
import { clientSession } from '@/lib/clientSession'
import { prisma } from '@/lib/prisma'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { ThemeToggle } from '@/components/ThemeToggle'
import { UserMenu } from '@/components/me/UserMenu'
import { MeNav, MeSidebar } from '@/components/me/MeNav'
import Link from 'next/link'

// The profile page behind BOTH web entries: `/u/<publicId>` (app/u/[id]) and
// `/@<username>` (rewritten to app/u/by-username/[username], usernames § 5).
// 🔒 Order: parse (the entry, its own format only) → limiter → resolve → gate.
// The entry hands over a RESOLVER and this component calls it only AFTER the
// limiter is charged, so a spent budget runs no lookup at all. Same gate,
// shell, blocked view and 404 for both; no redirect between them.
export type ProfileTarget = { id: number; publicId: string }

export async function ProfilePageView({ resolve }: { resolve: () => Promise<ProfileTarget | null> }) {
  const session = await auth()
  // Internal integers for the server reads; every PROP carries the PUBLIC id
  // (client components build API URLs and links from them, public-user-ids § 7).
  const viewerId = session?.user ? Number(session.user.id) : null
  const myId = clientSession(session)?.user?.id ?? null

  // The per-IP cap of /api/users/[id] and /api/users/by-username, the SAME
  // key string, so the two pages and the two API routes share one budget
  // (without it the SSR path is the cheap enumeration channel). The address
  // from getClientIp (a multi-entry XFF is untrusted), never a raw
  // `x-forwarded-for[0]`.
  const rl = await checkRate(`rl:profile:${getClientIp({ headers: await headers() })}:1m`, 60, 60)
  if (!rl.allowed) notFound()

  const target = await resolve()
  if (target === null) notFound()
  const { id: userId, publicId } = target
  const gate = await resolveProfileViewer(userId, viewerId)
  if (gate.status === 'gone') notFound()

  // Tier-gated viewers see a shell: display name + dummy avatar + follow
  // button. The user is findable but their content (XP, badges, check-ins,
  // social graph) stays hidden until the gate flips. Avatar is part of
  // the gated content — never include the imageUrl in the shell.
  //
  // Blocker-side viewers see the ProfileBlockedView: name + dummy avatar
  // + unblock button only. No follow button, no XP, no content. The
  // blocked-side equivalent is 'gone' → 404 (handled above).
  let profileBody: React.ReactNode
  if (gate.status === 'blocked-by-me') {
    profileBody = (
      <ProfileBlockedView userId={publicId} userName={gate.name} username={gate.username} myId={myId} />
    )
  } else if (gate.status === 'shell') {
    // Hydrate `isFollowing` so the follow button reflects current state
    // for logged-in viewers. The follow lookup is the only DB call here
    // — name comes from the gate result.
    const isFollowing = viewerId
      ? !!(await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: userId } },
          select: { followerId: true },
        }))
      : false
    profileBody = (
      <ProfileShell
        userId={publicId}
        userName={gate.name}
        username={gate.username}
        myId={myId}
        isFollowing={isFollowing}
      />
    )
  } else {
    // Same loader the API route uses — single source for the payload
    // shape. SSR calls Prisma directly; the API call goes over the wire.
    const profile = await loadProfile({ userId, gate })
    if (!profile) notFound()
    const viewerMutes = viewerId !== null && viewerId !== userId
      ? await isMuted(viewerId, userId)
      : false
    profileBody = (
      <>
          <ProfileHeader
            userId={profile.id}
            userName={profile.name}
            username={profile.username}
            userXp={profile.xp}
            userImageUrl={profile.imageUrl}
            myId={myId}
            isFollowing={profile.isFollowing}
            viewerMutes={viewerMutes}
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
            initialSessionPosts={profile.recentSessionPosts}
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
        <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid var(--chrome-border)',background:'var(--chrome-bg)',backdropFilter:'blur(18px)',position:'sticky',top:0,zIndex:10,flexShrink:0}}>
          <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <ThemeToggle />
            <UserMenu myId={myId!} name={session.user.name} email={session.user.email} pro={viewerPro} />
          </div>
        </header>
        <div style={{flex:1,display:'flex',overflow:'hidden'}}>
          <aside style={{width:180,flexShrink:0,borderRight:'1px solid var(--chrome-border)',padding:'16px 8px',display:'flex',flexDirection:'column',gap:2,overflowY:'auto'}} className="me-sidebar">
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
      <header style={{ padding: '0 16px', height: 'var(--hdr-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--chrome-border)', background: 'var(--chrome-bg)', backdropFilter: 'blur(18px)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link href="/" style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}>Verre</Link>
      </header>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 16px 0' }}>
        {profileBody}
      </div>
    </div>
  )
}
