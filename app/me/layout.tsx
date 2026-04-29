import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { UserMenu } from '@/components/me/UserMenu'
import { MeNav, MeSidebar } from '@/components/me/MeNav'

export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
      {/* Header */}
      <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',position:'sticky',top:0,zIndex:10,flexShrink:0}}>
        <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <ThemeToggle />
          <UserMenu
            name={session.user.name}
            email={session.user.email}
            pro={!!(session.user as { pro?: boolean }).pro}
          />
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div style={{flex:1,display:'flex',overflow:'hidden'}}>
        {/* Sidebar — desktop only */}
        <aside style={{width:180,flexShrink:0,borderRight:'1px solid rgba(255,255,255,0.04)',padding:'16px 8px',display:'flex',flexDirection:'column',gap:2,overflowY:'auto'}} className="me-sidebar">
          <MeSidebar />
        </aside>

        {/* Main content */}
        <main style={{flex:1,overflowY:'auto',padding:'16px 20px 100px'}}>
          <div style={{maxWidth:860,margin:'0 auto'}}>
            {children}
          </div>
        </main>
      </div>

      {/* Bottom nav — mobile only */}
      <div className="me-bottom-nav">
        <MeNav />
      </div>
    </div>
  )
}
