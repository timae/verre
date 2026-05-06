'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useDashboardSections } from './DashboardSettings'

const BASE_NAV = [
  { href: '/me',          icon: '⊞', label: 'Home',    id: null },
  { href: '/me/feed',     icon: '🌐', label: 'Feed',    id: null },
  { href: '/me/history',  icon: '◷', label: 'History', id: null },
  { href: '/me/saved',    icon: '★',  label: 'Saved',   id: null },
  { href: '/me/profile',  icon: '◉', label: 'Profile', id: null },
  { href: '/me/badges',   icon: '🏅', label: 'Badges',  id: 'show_badges' },
]

// Bottom nav (mobile)
export function MeNav() {
  const pathname = usePathname()
  const [sections] = useDashboardSections()
  const show = (id: string | null) => !id || sections.find(s => s.id === id)?.enabled !== false

  const items = BASE_NAV.filter(n => show(n.id))

  return (
    <nav style={{height:'calc(var(--nav-h) + 10px)',flexShrink:0,display:'flex',gap:10,borderTop:'1px solid rgba(255,255,255,0.04)',background:'rgba(10,10,9,0.88)',backdropFilter:'blur(18px)',position:'relative',zIndex:10,padding:'8px 14px calc(env(safe-area-inset-bottom,0px) + 8px)'}}>
      {items.map(({ href, icon, label }) => {
        const active = pathname === href
        return (
          <Link key={href} href={href} className={`nav-item${active ? ' active' : ''}`}>
            <span style={{fontSize:16,lineHeight:1}}>{icon}</span>
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

// Sidebar nav (desktop) — same items, different style
export function MeSidebar() {
  const pathname = usePathname()
  const [sections] = useDashboardSections()
  const show = (id: string | null) => !id || sections.find(s => s.id === id)?.enabled !== false

  const items = BASE_NAV.filter(n => show(n.id))

  return (
    <>
      {items.map(({ href, icon, label }) => {
        const active = pathname === href
        return (
          <Link key={href} href={href}
            style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px',borderRadius:10,fontSize:11,color: active ? 'var(--accent)' : 'var(--fg-dim)',textDecoration:'none',fontFamily:'var(--mono)',letterSpacing:'0.04em',background: active ? 'rgba(200,150,60,0.08)' : 'transparent',border: active ? '1px solid rgba(200,150,60,0.2)' : '1px solid transparent',transition:'background .12s,color .12s'}}
            className="me-nav-link"
          >
            <span style={{fontSize:15}}>{icon}</span>
            {label}
          </Link>
        )
      })}
    </>
  )
}
