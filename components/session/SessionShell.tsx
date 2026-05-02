'use client'
import { use, createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WineMeta, RatingMeta } from '@/lib/session'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SessionPanel } from './SessionPanel'
import { UserPanel } from './UserPanel'
import { useSession as useAuthSession } from 'next-auth/react'
import { sessionFetch } from '@/lib/sessionFetch'

// Server returns ratings id-keyed: { [identityId]: { displayName, ratings } }.
// Iterators (compare screen) use Object.entries; lookups (RatingScreen,
// WineListScreen) read myRatings, which is the per-user ratings map already
// projected from `data[myId].ratings` in SessionShell.
export type RatingsByIdentity = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>

type SessionCtx = {
  code: string; displayName: string; myId: string; isHost: boolean
  sessionMeta: { host: string; name: string; hostUserId: number | null; blind?: boolean } | null
  wines: WineMeta[]; allRatings: RatingsByIdentity
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
  const idFromUrl   = searchParams.get('id')   || ''
  const [storedName, setStoredName] = useState(() => {
    if (typeof window === 'undefined') return nameFromUrl
    return localStorage.getItem(`vr_name_${C}`) || nameFromUrl
  })
  const [storedId, setStoredId] = useState(() => {
    if (typeof window === 'undefined') return idFromUrl
    return localStorage.getItem(`vr_id_${C}`) || idFromUrl
  })
  useEffect(() => {
    let urlChanged = false
    if (nameFromUrl) {
      localStorage.setItem(`vr_name_${C}`, nameFromUrl)
      setStoredName(nameFromUrl)
      urlChanged = true
    }
    if (idFromUrl) {
      localStorage.setItem(`vr_id_${C}`, idFromUrl)
      setStoredId(idFromUrl)
      urlChanged = true
    }
    if (urlChanged) {
      const p = new URLSearchParams(searchParams.toString())
      p.delete('name')
      p.delete('id')
      const newUrl = p.toString() ? `/session/${C}?${p.toString()}` : `/session/${C}`
      router.replace(newUrl)
    }
  }, [C])
  const displayName = storedName || authSession?.user?.name || ''
  // Identity id falls back to a derived id for logged-in users so they can
  // act before the visit response lands (the server resolver returns the
  // same `u:<userId>` regardless). Anon users have no fallback — they need
  // their token's identity id to participate, which is set at join time.
  const myId = storedId || (authSession?.user?.id ? `u:${authSession.user.id}` : '')
  const needsName = !displayName && !authSession?.user
  const [isHostState] = useState(() => searchParams.get('host') === '1')
  const [showSessionPanel, setShowSessionPanel] = useState(false)
  const [showUserPanel,    setShowUserPanel]    = useState(false)

  useEffect(() => {
    if (needsName) router.replace(`/join/${C}`)
  }, [needsName, C])

  // Logged-in users hit /session/<code> with an auth cookie but may not yet
  // have an identities-map entry until the visit endpoint runs and registers
  // them. Firing the participant-gated GETs (meta, wines, ratings) before
  // visit completes returns 401 and triggers React Query backoff, which
  // shows up as a slow first wine load. Gate the queries on `readyToFetch`
  // so they wait for visit. Anons are already registered at join time and
  // can fetch immediately (their identity entry exists before SessionShell
  // mounts). Logged-in users wait until visit returns or a 1.5s safety
  // timeout, whichever comes first.
  const isLoggedIn = !!authSession?.user
  const [visitResolved, setVisitResolved] = useState(false)
  const readyToFetch = !isLoggedIn || visitResolved

  const { data: metaData } = useQuery({
    queryKey: ['session-meta', C],
    queryFn: () => sessionFetch(C, `/api/session/${C}`).then(r => r.ok ? r.json() : null),
    staleTime: 30_000,
    enabled: readyToFetch,
  })

  const { data: winesData = [], refetch: refetchWines } = useQuery<WineMeta[]>({
    queryKey: ['wines', C, myId],
    queryFn: async () => {
      const r = await sessionFetch(C, `/api/session/${C}/wines`)
      // Session is gone (deleted by host, expired, or never existed).
      // Clear any local cached state for this code so the user can't
      // get stuck in a redirect loop, then bounce to /join/<code> so
      // they see the "Session not found" page with the code shown.
      if (r.status === 404 && typeof window !== 'undefined') {
        try {
          localStorage.removeItem(`vr_anon_${C}`)
          localStorage.removeItem(`vr_name_${C}`)
          localStorage.removeItem(`vr_id_${C}`)
        } catch {}
        window.location.href = `/join/${C}`
        return []
      }
      return r.ok ? r.json() : []
    },
    refetchInterval: 5000,
    enabled: readyToFetch,
  })

  const { data: ratingsData = {} as RatingsByIdentity, refetch: refetchRatings } = useQuery<RatingsByIdentity>({
    queryKey: ['ratings', C],
    queryFn: () => sessionFetch(C, `/api/session/${C}/ratings`).then(r => r.ok ? r.json() : {}),
    refetchInterval: 5000,
    enabled: readyToFetch,
  })

  const refresh = useCallback(() => { refetchWines(); refetchRatings() }, [refetchWines, refetchRatings])

  const { data: bookmarksData = [] } = useQuery<{wine_id: string}[]>({
    queryKey: ['bookmarks'],
    queryFn: () => fetch('/api/me/bookmarks').then(r => r.ok ? r.json() : []),
    staleTime: 30_000,
  })
  const bookmarkedIds = new Set(bookmarksData.map(b => b.wine_id))

  useEffect(() => {
    // Safety timeout: if visit doesn't return within 1.5s (unlikely but
    // possible on a slow connection), unblock the queries anyway and let
    // React Query handle the 401 retry. Better than blocking the UI.
    const timeout = setTimeout(() => setVisitResolved(true), 1500)
    sessionFetch(C, `/api/session/${C}/visit`, { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        // Logged-in users may have been disambiguated server-side; pick up
        // the resolved per-session displayName so the UI and rating-key
        // lookups use the canonical form. Anon users hit the early-return
        // branch on the server (no body), so data has no displayName/id —
        // the join response already populated localStorage for them.
        if (data?.displayName && data.displayName !== storedName) {
          localStorage.setItem(`vr_name_${C}`, data.displayName)
          setStoredName(data.displayName)
        }
        if (data?.id && data.id !== storedId) {
          localStorage.setItem(`vr_id_${C}`, data.id)
          setStoredId(data.id)
        }
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout)
        setVisitResolved(true)
      })
  }, [C])

  // Host check is id-keyed against meta.hostUserId for logged-in users; the
  // legacy display-name comparison remains as a fallback for sessions whose
  // host is anonymous (no hostUserId stored).
  const hostUserId = metaData?.hostUserId ?? null
  const isCoHostById = !!(metaData?.coHostIds && myId && metaData.coHostIds.includes(myId))
  const isCoHostByName = !!(metaData?.coHosts && displayName && metaData.coHosts.includes(displayName))
  const isCoHost = isCoHostById || isCoHostByName
  const isHostById = !!(hostUserId && myId === `u:${hostUserId}`)
  const isHostByName = !!(metaData && !hostUserId && displayName && metaData.host === displayName)
  const isHost = isHostState || isHostById || isHostByName || isCoHost
  const myRatings = (myId && ratingsData[myId]?.ratings) || {}

  const isBlind = !!(metaData?.blind)
  const ctx: SessionCtx = {
    code: C, displayName, myId, isHost: !!isHost,
    sessionMeta: metaData || null,
    wines: winesData, allRatings: ratingsData, myRatings, refresh, bookmarkedIds, isBlind,
  }

  const navItems = [
    { label: 'Wines', path: `/session/${C}`,         icon: '🍷', id: 'wines' },
    { label: 'Rate',  path: `/session/${C}/rate`,     icon: '⭐', id: 'rate' },
    { label: 'Compare', path: `/session/${C}/compare`, icon: '◈', id: 'compare' },
  ]

  const sessionLabel = metaData?.name || C

  if (needsName) return null

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
