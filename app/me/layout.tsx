import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'

export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="px-4 h-[var(--hdr-h)] flex items-center justify-between border-b border-border/20 bg-bg/80 backdrop-blur-lg sticky top-0 z-10">
        <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <ThemeToggle />
          <div style={{display:'flex',alignItems:'center',gap:6,fontSize:10,color:'var(--fg-dim)',fontFamily:'var(--mono)'}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:'var(--accent2)'}} />
            {session.user.name}
          </div>
        </div>
      </header>

      <div className="flex max-w-4xl mx-auto">
        <nav className="hidden md:flex flex-col gap-1 w-48 p-4 flex-shrink-0">
          {[
            { href: '/me', label: '⊞ Dashboard' },
            { href: '/me/history', label: '◷ History' },
            { href: '/me/saved', label: '★ Saved wines' },
            { href: '/me/profile', label: '◉ Profile' },
          ].map(({ href, label }) => (
            <Link key={href} href={href}
              className="px-3 py-2 rounded-lg text-sm text-fg-dim hover:text-fg hover:bg-bg3 transition-colors">
              {label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 min-w-0 p-4">{children}</main>
      </div>
    </div>
  )
}
