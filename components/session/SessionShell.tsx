'use client'
import { use, createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WineMeta, RatingMeta } from '@/lib/session'

type SessionCtx = {
  code: string; displayName: string; isHost: boolean
  sessionMeta: { host: string; name: string; hostUserId: number | null } | null
  wines: WineMeta[]; allRatings: Record<string, Record<string, RatingMeta>>
  myRatings: Record<string, RatingMeta>; refresh: () => void
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

  const [displayName] = useState(() => searchParams.get('name') || '')
  const [isHostState] = useState(() => searchParams.get('host') === '1')

  const { data: metaData } = useQuery({
    queryKey: ['session-meta', C],
    queryFn: () => fetch(`/api/session/${C}`).then(r => r.json()),
    staleTime: 30_000,
  })

  const { data: winesData = [], refetch: refetchWines } = useQuery<WineMeta[]>({
    queryKey: ['wines', C],
    queryFn: () => fetch(`/api/session/${C}/wines`).then(r => r.json()),
    refetchInterval: 5000,
  })

  const { data: ratingsData = {}, refetch: refetchRatings } = useQuery<Record<string, Record<string, RatingMeta>>>({
    queryKey: ['ratings', C],
    queryFn: () => fetch(`/api/session/${C}/ratings`).then(r => r.json()),
    refetchInterval: 5000,
  })

  const refresh = useCallback(() => { refetchWines(); refetchRatings() }, [refetchWines, refetchRatings])

  useEffect(() => {
    fetch(`/api/session/${C}/visit`, { method: 'POST' }).catch(() => {})
  }, [C])

  const isHost = isHostState || (metaData && displayName && metaData.host === displayName)
  const myRatings = ratingsData[displayName] || {}

  const ctx: SessionCtx = {
    code: C, displayName, isHost: !!isHost,
    sessionMeta: metaData || null,
    wines: winesData, allRatings: ratingsData, myRatings, refresh,
  }

  const navItems = [
    { label: 'Wines', path: `/session/${C}`, icon: '🍷', id: 'wines' },
    { label: 'Rate', path: `/session/${C}/rate`, icon: '⭐', id: 'rate' },
    { label: 'Compare', path: `/session/${C}/compare`, icon: '◈', id: 'compare' },
  ]

  const sessionLabel = metaData?.name || C

  return (
    <Ctx.Provider value={ctx}>
      <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
        {/* Header */}
        <header style={{height:'var(--hdr-h)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',zIndex:10}}>
          <span style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)'}}>Verre</span>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.3)',background:'rgba(143,184,122,0.08)',padding:'4px 10px',borderRadius:3}}>
              {sessionLabel}
            </span>
            <div style={{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.06em',color:'var(--fg-dim)',border:'1px solid var(--border)',background:'var(--bg2)',padding:'5px 10px',borderRadius:3,display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:5,height:5,borderRadius:'50%',background:'var(--accent2)'}} />
              {displayName || 'anon'}
            </div>
          </div>
        </header>

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
          <button onClick={() => router.push('/')} className="nav-item" style={{flex:1,color:'rgba(255,255,255,0.2)',borderColor:'transparent',background:'transparent'}}>
            <span style={{fontSize:16,lineHeight:1}}>←</span>
            <span>Leave</span>
          </button>
        </nav>
      </div>
    </Ctx.Provider>
  )
}
