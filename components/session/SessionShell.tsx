'use client'
import { use, createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WineMeta, RatingMeta } from '@/lib/session'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SessionPanel } from './SessionPanel'
import { UserPanel } from './UserPanel'
import { useSession as useAuthSession } from 'next-auth/react'

type SessionCtx = {
  code: string; displayName: string; isHost: boolean
  sessionMeta: { host: string; name: string; hostUserId: number | null; blind?: boolean } | null
  wines: WineMeta[]; allRatings: Record<string, Record<string, RatingMeta>>
  myRatings: Record<string, RatingMeta>; refresh: () => void
  bookmarkedIds: Set<string>
  isBlind: boolean
}
const Ctx = createContext<SessionCtx | null>(null)
export const useSession = () => {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession must be used inside SessionShell')
  return ctx
}

export function SessionShell({ children, params }: { children: React.ReactNode; params: Promise<{ code: string }> }) {
  const { code } = use(params)
  const C = code.toUpperCase()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const { data: authSession } = useAuthSession()
  const nameFromUrl = searchParams.get('name') || ''
  const displayName = nameFromUrl || authSession?.user?.name || ''
  const needsName = !displayName && !authSession?.user
  const [nameInput, setNameInput] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [isHostState] = useState(() => searchParams.get('host') === '1')
  const [showSessionPanel, setShowSessionPanel] = useState(false)
  const [showUserPanel,    setShowUserPanel]    = useState(false)

  function confirmName() {
    const n = nameInput.trim()
    if (!n) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('name', n)
    router.replace(`/session/${C}?${params.toString()}`)
  }

  const { data: metaData } = useQuery({
    queryKey: ['session-meta', C],
    queryFn: () => fetch(`/api/session/${C}`).then(r => r.json()),
    staleTime: 30_000,
  })

  const { data: winesData = [], refetch: refetchWines } = useQuery<WineMeta[]>({
    queryKey: ['wines', C, displayName],
    queryFn: () => fetch(`/api/session/${C}/wines?name=${encodeURIComponent(displayName)}`).then(r => r.json()),
    refetchInterval: 5000,
  })

  const { data: ratingsData = {}, refetch: refetchRatings } = useQuery<Record<string, Record<string, RatingMeta>>>({
    queryKey: ['ratings', C],
    queryFn: () => fetch(`/api/session/${C}/ratings`).then(r => r.json()),
    refetchInterval: 5000,
  })

  const refresh = useCallback(() => { refetchWines(); refetchRatings() }, [refetchWines, refetchRatings])

  const { data: bookmarksData = [] } = useQuery<{wine_id: string}[]>({
    queryKey: ['bookmarks'],
    queryFn: () => fetch('/api/me/bookmarks').then(r => r.ok ? r.json() : []),
    staleTime: 30_000,
  })
  const bookmarkedIds = new Set(bookmarksData.map(b => b.wine_id))

  useEffect(() => {
    fetch(`/api/session/${C}/visit`, { method: 'POST' }).catch(() => {})
  }, [C])

  const isHost = isHostState || (metaData && displayName && metaData.host === displayName)
  const myRatings = ratingsData[displayName] || {}

  const isBlind = !!(metaData?.blind)
  const ctx: SessionCtx = {
    code: C, displayName, isHost: !!isHost,
    sessionMeta: metaData || null,
    wines: winesData, allRatings: ratingsData, myRatings, refresh, bookmarkedIds, isBlind,
  }

  const navItems = [
    { label: 'Wines', path: `/session/${C}`,         icon: '🍷', id: 'wines' },
    { label: 'Rate',  path: `/session/${C}/rate`,     icon: '⭐', id: 'rate' },
    { label: 'Compare', path: `/session/${C}/compare`, icon: '◈', id: 'compare' },
  ]

  const sessionLabel = metaData?.name || C

  return (
    <Ctx.Provider value={ctx}>
      <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
        {/* Header */}
        <header style={{height:'var(--hdr-h)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',zIndex:10}}>
          <Link href="/me" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <ThemeToggle />
            <button
              onClick={() => setShowSessionPanel(true)}
              title="Session settings"
              style={{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.3)',background:'rgba(143,184,122,0.08)',padding:'4px 10px',borderRadius:3,cursor:'pointer'}}
            >
              {sessionLabel}
            </button>
            <button
              onClick={() => setShowUserPanel(true)}
              style={{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.06em',color:'var(--fg-dim)',border:'1px solid var(--border)',background:'var(--bg2)',padding:'5px 10px',borderRadius:3,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}
            >
              <div style={{width:5,height:5,borderRadius:'50%',background:'var(--accent2)'}} />
              {displayName || 'anon'}
            </button>
          </div>
        </header>

        {needsName && (
          <div style={{position:'fixed',inset:0,zIndex:100,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.75)',backdropFilter:'blur(6px)'}}>
            <div style={{background:'var(--bg2)',borderRadius:16,padding:24,width:'min(90vw,360px)',border:'1px solid var(--border)'}}>
              <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:4}}>welcome</div>
              <div style={{fontSize:12,color:'var(--fg-dim)',marginBottom:16,lineHeight:1.6}}>Enter your name to join this tasting.</div>
              <div className="field">
                <div className="fl">your name</div>
                <input ref={nameInputRef} className="fi" value={nameInput} onChange={e => setNameInput(e.target.value)}
                  placeholder="firstname or alias" autoFocus
                  onKeyDown={e => e.key === 'Enter' && confirmName()} />
              </div>
              <button className="btn-p" onClick={confirmName}>→ join</button>
            </div>
          </div>
        )}
        {showSessionPanel && (
          <SessionPanel
            onClose={() => setShowSessionPanel(false)}
            onLeave={() => { setShowSessionPanel(false); router.push('/') }}
          />
        )}
        {showUserPanel && (
          <UserPanel onClose={() => setShowUserPanel(false)} />
        )}

        {/* Content */}
        <main style={{flex:1,overflowY:'auto'}}>{children}</main>

        {/* Nav */}
        <nav style={{height:'calc(var(--nav-h) + 10px)',flexShrink:0,display:'flex',gap:10,borderTop:'1px solid rgba(255,255,255,0.04)',background:'rgba(10,10,9,0.88)',backdropFilter:'blur(18px)',zIndex:10,padding:'8px 14px calc(env(safe-area-inset-bottom,0px) + 8px)'}}>
          {navItems.map(({ label, path, icon, id }) => {
            const active = pathname === path
            return (
              <Link key={path} href={path} className={`nav-item${active ? ' active' : ''}`}>
                <span style={{fontSize:16,lineHeight:1}}>{icon}</span>
                <span>{label}</span>
              </Link>
            )
          })}
          <button onClick={() => setShowUserPanel(true)} className="nav-item" style={{flex:1}}>
            <span style={{fontSize:14,lineHeight:1}}>👤</span>
            <span>You</span>
          </button>
          <button onClick={() => router.push('/me')} className="nav-item" style={{flex:1,color:'var(--fg-faint)',borderColor:'transparent',background:'transparent'}}>
            <span style={{fontSize:16,lineHeight:1}}>←</span>
            <span>Leave</span>
          </button>
        </nav>
      </div>
    </Ctx.Provider>
  )
}
