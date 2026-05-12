'use client'
import { use, createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WireWine, RatingMeta } from '@/lib/session'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SessionPanel } from './SessionPanel'
import { UserPanel } from './UserPanel'
import { useSession as useAuthSession } from 'next-auth/react'
import { sessionFetch } from '@/lib/sessionFetch'
import { normalizeCode, formatCode, sessionPath, joinPath } from '@/lib/sessionCode'

// Server returns ratings id-keyed: { [identityId]: { displayName, ratings } }.
// Iterators (compare screen) use Object.entries; lookups (RatingScreen,
// WineListScreen) read myRatings, which is the per-user ratings map already
// projected from `data[myId].ratings` in SessionShell.
export type RatingsByIdentity = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>

type Participant = { id: string; displayName: string }

type SessionCtx = {
  code: string; displayName: string; myId: string; isHost: boolean
  // Provider flag — distinct from isHost. True when the viewer is in
  // meta.providerIds. Providers can add wines and edit/delete only the
  // ones they added themselves (matched server-side via the wine's
  // `addedByIdentityId`). Use this to gate wine-row affordances on the
  // provider's own rows without conflating with host powers.
  isProvider: boolean
  sessionMeta: {
    host: string; name: string
    hostUserId: number | null
    hostIdentityId?: string
    blind?: boolean
    participants: Participant[]
    coHostIds: string[]
    providerIds?: string[]
    // Number of banned identities for this session. Only populated for
    // host/cohost viewers (others always see 0). Used to conditionally
    // render the BannedUsersSection — appears when >0, hidden when 0,
    // updates via the polled session GET so cross-host bans propagate.
    banCount?: number
    // Viewer's block-pair list scoped to participants in THIS session.
    // viewerBlocksOut = identities the viewer has blocked; viewerBlocksIn
    // = identities that have blocked the viewer. Anon viewers get
    // empty arrays. SECURITY: never log / mirror to analytics / persist
    // outside the response. See CLAUDE.md "Profile blocking" section.
    viewerBlocksOut?: string[]
    viewerBlocksIn?: string[]
  } | null
  wines: WireWine[]; allRatings: RatingsByIdentity
  myRatings: Record<string, RatingMeta>; refresh: () => void
  bookmarkedIds: Set<string>
  // True when the viewer has a NextAuth session cookie (logged-in
  // user). Gates surfaces that require an account: bookmarks, profile,
  // anything that writes to the user's lifetime data.
  isLoggedIn: boolean
  isBlind: boolean
  // True before the first wines fetch settles. Distinguishes "loading
  // the wine list" from "host hasn't added any yet" — visually
  // identical otherwise, but the message should differ.
  winesLoading: boolean
}
const Ctx = createContext<SessionCtx | null>(null)
export const useSession = () => {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession must be used inside SessionShell')
  return ctx
}

export function SessionShell({ children, params }: { children: React.ReactNode; params: Promise<{ code: string }> }) {
  const { code } = use(params)
  // Canonical form for React Query cache keys, Redis lookups, and localStorage
  // suffixes. If normalize returns null (user typed a malformed code into the
  // URL bar), fall through with the raw uppercased value — the wines GET will
  // 404 and the existing redirect-to-/join path takes over.
  const C = normalizeCode(code) ?? code.toUpperCase()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const { data: authSession } = useAuthSession()
  const nameFromUrl = searchParams.get('name') || ''
  const idFromUrl   = searchParams.get('id')   || ''
  // Initialize state from URL params only — NOT from localStorage. SSR
  // can't read localStorage, so reading it in the useState initializer
  // produces a server tree that says "no stored name" and a client tree
  // that has the name, causing a hydration mismatch. The mount effect
  // below reads localStorage post-hydration and updates state, costing
  // one frame where the shell shows "anon" before snapping to the real
  // name.
  const [storedName, setStoredName] = useState(nameFromUrl)
  const [storedId, setStoredId] = useState(idFromUrl)
  // True after the first post-mount effect runs. Used by the redirect-
  // to-/join gate below to avoid bouncing an anon participant in the
  // single frame between SSR (no localStorage) and the localStorage
  // hydration completing.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    // Bootstrap params (`name`, `id`, `host`) are presentation-only — captured
    // synchronously into useState initializers (above for name/id, below for
    // host), then stripped here so the URL doesn't carry them around.
    // Copy-pasting a URL with `host=1` would otherwise show the recipient
    // host UI even though the server rejects their actions.
    let urlChanged = false
    if (nameFromUrl) {
      localStorage.setItem(`vr_name_${C}`, nameFromUrl)
      setStoredName(nameFromUrl)
      urlChanged = true
    } else {
      // No URL param — hydrate from localStorage if available. Runs once
      // post-mount so SSR and first client render match.
      const fromLs = localStorage.getItem(`vr_name_${C}`)
      if (fromLs) setStoredName(fromLs)
    }
    if (idFromUrl) {
      localStorage.setItem(`vr_id_${C}`, idFromUrl)
      setStoredId(idFromUrl)
      urlChanged = true
    } else {
      const fromLs = localStorage.getItem(`vr_id_${C}`)
      if (fromLs) setStoredId(fromLs)
    }
    if (searchParams.get('host')) urlChanged = true
    if (urlChanged) {
      const p = new URLSearchParams(searchParams.toString())
      p.delete('name')
      p.delete('id')
      p.delete('host')
      const base = sessionPath(C)
      const newUrl = p.toString() ? `${base}?${p.toString()}` : base
      router.replace(newUrl)
    }
    setHydrated(true)
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
    // Gate on `hydrated` so the redirect doesn't fire in the first-render
    // frame before localStorage has been read. An anon participant has
    // their displayName in localStorage only — without the gate, they'd
    // briefly satisfy `needsName=true` on first render and get bounced
    // to /join before the hydration effect could populate storedName.
    if (hydrated && needsName) router.replace(joinPath(C))
  }, [hydrated, needsName, C])

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

  // Polled every 5s so participant joins/leaves and cohost role changes
  // surface in the UI without a manual reload. Same cadence as wines /
  // ratings so the whole session view stays consistent.
  const { data: metaData } = useQuery({
    queryKey: ['session-meta', C],
    queryFn: () => sessionFetch(C, `/api/session/${C}`).then(r => r.ok ? r.json() : null),
    refetchInterval: 5000,
    enabled: readyToFetch,
  })

  const { data: winesData = [], refetch: refetchWines, isPending: winesPending } = useQuery<WireWine[]>({
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
        window.location.href = joinPath(C)
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
        // Unconditional write — React setState bails out on === values,
        // and overwriting localStorage with the same string is a no-op.
        // Avoiding the comparison sidesteps the stale-closure trap (the
        // effect dep array is [C], so `storedName`/`storedId` would be
        // captured at attach time and could miss a post-mount hydration
        // update).
        if (data?.displayName) {
          localStorage.setItem(`vr_name_${C}`, data.displayName)
          setStoredName(data.displayName)
        }
        if (data?.id) {
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

  // Host check — mirrors server's isHostByIdentity. Pure id-based.
  const hostIdentityId = metaData?.hostIdentityId ?? null
  const hostUserId = metaData?.hostUserId ?? null
  const isCoHost = !!(metaData?.coHostIds && myId && metaData.coHostIds.includes(myId))
  const isHostById =
    !!(hostIdentityId && myId === hostIdentityId) ||
    !!(hostUserId && myId === `u:${hostUserId}`)
  const isHost = isHostState || isHostById || isCoHost
  // Provider check — distinct from isHost. Providers can add wines and
  // edit/delete only their own. Mutually exclusive with cohost in the
  // server-side role model, but mirroring the flag separately here so
  // the UI can branch on "host vs provider" without re-checking lists.
  const isProvider = !!(metaData?.providerIds && myId && metaData.providerIds.includes(myId))
  const myRatings = (myId && ratingsData[myId]?.ratings) || {}

  const isBlind = !!(metaData?.blind)
  const ctx: SessionCtx = {
    code: C, displayName, myId, isHost: !!isHost, isProvider,
    sessionMeta: metaData || null,
    wines: winesData, allRatings: ratingsData, myRatings, refresh, bookmarkedIds,
    isLoggedIn, isBlind,
    // Loading is true until the first fetch resolves; the gate
    // (`enabled: readyToFetch`) keeps it pending while we resolve
    // the identity, which is exactly the period a user sees a
    // session URL with no wines yet rendered.
    winesLoading: winesPending,
  }

  const navItems = [
    { label: 'Wines', path: sessionPath(C),            icon: '🍷', id: 'wines' },
    { label: 'Rate',  path: sessionPath(C, 'rate'),    icon: '⭐', id: 'rate' },
    { label: 'Compare', path: sessionPath(C, 'compare'), icon: '◈', id: 'compare' },
  ]

  const sessionLabel = metaData?.name || formatCode(C)

  if (needsName) return null

  return (
    <Ctx.Provider value={ctx}>
      <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
        {/* Header */}
        <header style={{height:'var(--hdr-h)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.82)',backdropFilter:'blur(18px)',zIndex:10}}>
          <Link href={authSession?.user ? '/me' : '/'} style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
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
            onLeave={() => { setShowSessionPanel(false); router.push(authSession?.user ? '/me' : '/') }}
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
          <button onClick={() => router.push(authSession?.user ? '/me' : '/')} className="nav-item" style={{flex:1,color:'var(--fg-faint)',borderColor:'transparent',background:'transparent'}}>
            <span style={{fontSize:16,lineHeight:1}}>←</span>
            <span>Leave</span>
          </button>
        </nav>
      </div>
    </Ctx.Provider>
  )
}
