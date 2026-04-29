import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SignOutButton } from '@/components/auth/SignOutButton'

export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <div style={{minHeight:'100vh',background:'var(--bg)'}}>
      <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',position:'sticky',top:0,zIndex:10}}>
        <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <ThemeToggle />
          <div style={{display:'flex',alignItems:'center',gap:6,fontSize:10,color:'var(--fg-dim)',fontFamily:'var(--mono)'}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:session.user.pro ? 'var(--accent)' : 'var(--accent2)'}} />
            {session.user.name}
            {session.user.pro && <span style={{fontSize:8,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',padding:'1px 4px',borderRadius:2}}>pro</span>}
          </div>
          <SignOutButton />
        </div>
      </header>

      <div style={{display:'flex',maxWidth:960,margin:'0 auto'}}>
        <nav style={{display:'flex',flexDirection:'column',gap:2,width:176,padding:16,flexShrink:0}}>
          {[
            { href: '/me',          label: '⊞ Dashboard' },
            { href: '/me/history',  label: '◷ History' },
            { href: '/me/saved',    label: '★ Saved wines' },
            { href: '/me/profile',  label: '◉ Profile' },
            { href: '/me/badges',   label: '🏅 Badges' },
          ].map(({ href, label }) => (
            <Link key={href} href={href} style={{display:'block',padding:'6px 10px',borderRadius:8,fontSize:11,color:'var(--fg-dim)',textDecoration:'none',fontFamily:'var(--mono)',letterSpacing:'0.04em'}}>
              {label}
            </Link>
          ))}
        </nav>
        <main style={{flex:1,minWidth:0,padding:16}}>{children}</main>
      </div>
    </div>
  )
}
