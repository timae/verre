'use client'
import { use, createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WireWine, RatingMeta } from '@/lib/session'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SessionPanel } from './SessionPanel'
import { UserMenu } from '@/components/me/UserMenu'
import { SessionAnonMenu } from './SessionAnonMenu'
import { useSession as useAuthSession } from 'next-auth/react'
import { sessionFetch } from '@/lib/sessionFetch'
import { normalizeCode, formatCode, isPublicUserId } from '@verre/core'
import { sessionPath, joinPath } from '@/lib/sessionCode'
import { DirtyGuardProvider, useDirtyGuard } from '@/lib/dirtyGuard'
import { UndoChipProvider } from '@/lib/undoChip'

// Server returns ratings id-keyed: { [identityId]: { displayName, ratings } }.
// Iterators (compare screen) use Object.entries; lookups (WineModal,
// WineListScreen) read myRatings, which is the per-user ratings map already
// projected from `data[myId].ratings` in SessionShell.
export type RatingsByIdentity = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>

type Participant = { id: string; displayName: string; imageUrl?: string | null }

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
    hostUserId: string | null
    hostIdentityId?: string
    blind?: boolean
    // "Blind for all" — when true the host/cohost/provider/wine-adder
    // bypasses are disabled and even the host sees redacted wines. Per-
    // session, host/cohost-toggleable, not pro-gated (only meta.blind
    // itself is pro). See lib/wineRedaction.ts.
    blindForEveryone?: boolean
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
// Wire shape of GET /api/session/:code/state — the aggregate poll. Each
// section is null when that section failed server-side (partial
// degradation); the queryFn substitutes the previous data in that case.
type SessionStateData = {
  meta: SessionCtx['sessionMeta']
  wines: WireWine[] | null
  ratings: RatingsByIdentity | null
}

// 🔒 An answer from an instance still on the integer ids (the rolling-deploy
// window, public-user-ids § 11): keyed by `u:<int>`, it would hide the
// viewer's own ratings, and a rating write carries no user id, so a re-rate
// would replace the stored notes. The queryFn keeps the last good data.
const INTEGER_IDENTITY = /^u:\d/
function isIntegerIdState(s: SessionStateData): boolean {
  return typeof (s.meta as { hostUserId?: unknown } | null)?.hostUserId === 'number'
    || !!s.meta?.participants?.some(p => INTEGER_IDENTITY.test(p.id))
    || Object.keys(s.ratings ?? {}).some(id => INTEGER_IDENTITY.test(id))
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

  const { data: authSession, update: updateAuthSession } = useAuthSession()
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
      // `vr_id_` keeps anonymous (`a:`) identities only (see myId below).
      if (idFromUrl.startsWith('a:')) localStorage.setItem(`vr_id_${C}`, idFromUrl)
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
  // 🔒 A signed-in user's identity comes from the AUTH SESSION, never from a
  // stored `vr_id_` (public-user-ids § 7): a stale stored `u:<int>` from before
  // the switch would otherwise win, and a failed visit never overwrites it.
  // `authSession.user.id` is the public id (lib/clientSession.ts), so this is
  // the same `u:<publicId>` the server's payloads use. `vr_id_` holds `a:`
  // identities only; anon users need their token's identity id, set at join.
  // 🔒 A session id that isn't a public id came from an instance still on the
  // integer ids (rolling deploy, § 11): the viewer is NOT yet known (no
  // fetch, nothing to rate) until a fresh session read brings the public id.
  const sessionUserId = authSession?.user?.id
  const staleSessionId = !!sessionUserId && !isPublicUserId(sessionUserId)
  const myId = sessionUserId
    ? (staleSessionId ? '' : `u:${sessionUserId}`)
    : storedId.startsWith('a:') ? storedId : ''
  // `update` is rebuilt on every session / loading change (next-auth's useMemo),
  // so it lives in a ref: depending on it would re-run this effect after each
  // call and retry back-to-back instead of every 5 s.
  const updateAuthRef = useRef(updateAuthSession)
  useEffect(() => { updateAuthRef.current = updateAuthSession })
  useEffect(() => {
    if (!staleSessionId) return
    // update() answers null when the read failed or the session is gone (signed
    // out or revoked meanwhile): the stale id would then stay for good, so after
    // three in a row (online) reload and let the server render what is true now.
    // `undefined` = a read was already in flight (a no-op). `live`: a read still
    // in flight when the guard ends (staleness cleared, page left) never reloads.
    let live = true
    let nulls = 0
    const tick = async () => {
      const s = await updateAuthRef.current()
      if (!live || s === undefined) return
      if (s !== null) { nulls = 0; return }
      if (++nulls >= 3 && navigator.onLine) window.location.reload()
    }
    void tick()
    const t = setInterval(() => { void tick() }, 5000)
    return () => { live = false; clearInterval(t) }
  }, [staleSessionId])
  const needsName = !displayName && !authSession?.user
  const [isHostState] = useState(() => searchParams.get('host') === '1')
  const [showSessionPanel, setShowSessionPanel] = useState(false)

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
  // The server's "too many codes" copy (leak-fixes F2): a non-member whose
  // wrong-code budget is spent gets a 429 from /visit and /state. Shown in
  // place of the shell, never an empty one.
  const [limitedMsg, setLimitedMsg] = useState<string | null>(null)
  const noteLimited = useCallback(async (r: Response) => {
    const body = await r.clone().json().catch(() => ({})) as { error?: string }
    setLimitedMsg(body.error || 'Too many codes tried. Try again later.')
  }, [])
  const readyToFetch = (!isLoggedIn || visitResolved) && !staleSessionId

  // Single aggregate poll every 5s: GET /api/session/:code/state returns
  // { meta, wines, ratings } in one request (was three independent 5s
  // polls). Key includes myId because the wines section is viewer-dependent
  // (blind redaction, isMine). A null section means that section failed
  // server-side (partial degradation) — keep the previous data for it
  // instead of blanking the UI.
  const queryClient = useQueryClient()
  const { data: stateData, refetch: refetchState, isPending: statePending } = useQuery<SessionStateData>({
    queryKey: ['session-state', C, myId],
    queryFn: async () => {
      const prev = queryClient.getQueryData<SessionStateData>(['session-state', C, myId])
      const empty: SessionStateData = { meta: null, wines: null, ratings: null }
      const r = await sessionFetch(C, `/api/session/${C}/state`)
      // Session is gone (deleted by host, expired, or never existed).
      // Clear any local cached state for this code so the user can't
      // get stuck in a redirect loop, then bounce to /join/<code> so
      // they see the "Session not found" page with the code shown.
      //
      // Use router.replace (client-side nav), NOT window.location.href.
      // A hard nav triggers the browser's beforeunload popup if any
      // descendant has unsaved edits (e.g. an open WineModal with a
      // dirty rate pane) — and the session is genuinely gone, so the
      // popup would be a meaningless "do you want to leave?" prompt.
      // Client-side nav unmounts the React tree cleanly without it.
      if (r.status === 404 && typeof window !== 'undefined') {
        try {
          localStorage.removeItem(`vr_anon_${C}`)
          localStorage.removeItem(`vr_name_${C}`)
          localStorage.removeItem(`vr_id_${C}`)
        } catch {}
        router.replace(joinPath(C))
        return prev ?? empty
      }
      if (r.status === 429) { await noteLimited(r); return prev ?? empty }
      if (!r.ok) return prev ?? empty
      setLimitedMsg(null)
      const next: SessionStateData = await r.json()
      if (isIntegerIdState(next)) return prev ?? empty
      // Accepted trade-off: keeping prev on a failed section can hold data
      // that a just-flipped setting would now redact (e.g. blind toggled on
      // while the wines section errors). Blind is spoiler protection, not
      // retroactive secrecy — the data was already delivered to this viewer
      // — and the next successful poll re-redacts.
      return {
        meta: next.meta ?? prev?.meta ?? null,
        wines: next.wines ?? prev?.wines ?? null,
        ratings: next.ratings ?? prev?.ratings ?? null,
      }
    },
    refetchInterval: 5000,
    enabled: readyToFetch,
  })
  const metaData = stateData?.meta ?? null
  const winesData = stateData?.wines ?? []
  const ratingsData = stateData?.ratings ?? ({} as RatingsByIdentity)

  const refresh = useCallback(() => { refetchState() }, [refetchState])

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
      .then(async r => {
        if (r.status === 429) { await noteLimited(r); return null }
        return r.ok ? r.json() : null
      })
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
        if (typeof data?.id === 'string' && data.id.startsWith('a:')) {
          localStorage.setItem(`vr_id_${C}`, data.id)
          setStoredId(data.id)
        }
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout)
        setVisitResolved(true)
      })
  }, [C, noteLimited])

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
  // Single role badge for the user-menu identity block. Strict-host
  // takes precedence over the URL-driven isHostState fallback (which
  // applies before the metadata payload lands). Order matches server-
  // side role precedence: host > co-host > provider > taster (null).
  const myRole: 'host' | 'co-host' | 'provider' | null =
    isHostById ? 'host'
    : isCoHost ? 'co-host'
    : isProvider ? 'provider'
    : null
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
    // session URL with no wines yet rendered. A null wines section
    // (degraded response before any successful one) also counts as
    // loading — [] would falsely render "no wines yet".
    winesLoading: statePending || !stateData?.wines,
  }

  // Bottom-nav tab order. Wines is the default landing (session root
  // redirects here). Tapping a wine opens the modal on the Wine Info
  // pane; an inline "Rate" button on each unrated row opens the modal
  // on the Rate pane directly.
  const navItems = [
    { label: 'Wines', path: sessionPath(C, 'wines'),   icon: '🍷', id: 'wines' },
    { label: 'Compare', path: sessionPath(C, 'compare'), icon: '◈', id: 'compare' },
  ]

  const sessionLabel = metaData?.name || formatCode(C)

  if (needsName) return null
  if (limitedMsg) {
    return (
      <div className="app-bg" style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
        <div className="lobby-card lobby-form" style={{width:'100%',maxWidth:400,textAlign:'center'}}>
          <p style={{fontSize:13,color:'var(--fg-dim)',marginBottom:16}}>{limitedMsg}</p>
          <Link href={authSession?.user ? '/me' : '/'} className="btn-p" style={{textDecoration:'none',display:'block',textAlign:'center'}}>← back to {authSession?.user ? 'dashboard' : 'home'}</Link>
        </div>
      </div>
    )
  }

  // The DirtyGuardProvider wraps the entire shell so any descendant
  // (WineModal today, future forms tomorrow) can register a guard that
  // intercepts navigation surfaces below. Header logo / session badge /
  // user badge / bottom-nav Links / Leave all route through the guard.
  // ThemeToggle stays unguarded — toggling a theme inside a dirty modal
  // shouldn't pop a confirm.
  return (
    <DirtyGuardProvider>
      <UndoChipProvider code={C} refresh={refresh}>
        <Ctx.Provider value={ctx}>
          <SessionShellChrome
            authUser={authSession?.user as { id?: string; name?: string | null; email?: string | null; pro?: boolean } | undefined}
            displayName={displayName}
            code={C}
            myRole={myRole}
            sessionLabel={sessionLabel}
            showSessionPanel={showSessionPanel}
            setShowSessionPanel={setShowSessionPanel}
            navItems={navItems}
            pathname={pathname}
            router={router}
            onAnonRenamed={(newName: string) => {
              // Server rename succeeded — persist to localStorage and
              // update state so the header label, dropdown, and any
              // descendant reading `displayName` from context re-render.
              // Polling (refresh) keeps the participants list / ratings
              // wired to the same identity-id, so just refresh after.
              localStorage.setItem(`vr_name_${C}`, newName)
              setStoredName(newName)
              refresh()
            }}
          >{children}</SessionShellChrome>
        </Ctx.Provider>
      </UndoChipProvider>
    </DirtyGuardProvider>
  )
}

// Inner chrome — split out so useDirtyGuard() can be called below the
// provider. Reads from props instead of pulling SessionShell's local
// state directly, to keep the boundary explicit.
function SessionShellChrome({
  authUser, displayName, code, myRole, sessionLabel,
  showSessionPanel, setShowSessionPanel,
  navItems, pathname, router, onAnonRenamed, children,
}: {
  authUser: { id?: string; name?: string | null; email?: string | null; pro?: boolean } | undefined
  displayName: string
  code: string
  myRole: 'host' | 'co-host' | 'provider' | null
  sessionLabel: string
  showSessionPanel: boolean
  setShowSessionPanel: (v: boolean) => void
  navItems: { label: string; path: string; icon: string; id: string }[]
  pathname: string
  router: ReturnType<typeof useRouter>
  onAnonRenamed: (newName: string) => void
  children: ReactNode
}) {
  const guard = useDirtyGuard()
  // Wrap a navigation action with the dirty-guard check. If a guard is
  // active, it intercepts and may prompt; otherwise the action runs
  // immediately.
  const guardedNav = (action: () => void) => {
    if (guard) guard.attemptNav(action)
    else action()
  }
  // Wrap a Link click for the same gating. Returning preventDefault
  // when guarded keeps Next from doing the SPA push behind our back —
  // the guard's proceed callback fires router.push if/when the user
  // resolves the prompt.
  const onGuardedLinkClick = (href: string) => (e: React.MouseEvent) => {
    if (!guard) return
    e.preventDefault()
    guard.attemptNav(() => router.push(href))
  }
  const leaveHref = authUser ? '/me' : '/'

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>
      <header style={{height:'var(--hdr-h)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',borderBottom:'1px solid var(--chrome-border)',background:'var(--chrome-bg)',backdropFilter:'blur(18px)',zIndex:10}}>
        <Link
          href={leaveHref}
          onClick={onGuardedLinkClick(leaveHref)}
          style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}
        >Verre</Link>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <ThemeToggle />
          <button
            onClick={() => guardedNav(() => setShowSessionPanel(true))}
            title="Session settings"
            style={{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.3)',background:'rgba(143,184,122,0.08)',padding:'4px 10px',borderRadius:3,cursor:'pointer'}}
          >{sessionLabel}</button>
          {/* Logged-in users get the same UserMenu dropdown as /me and
              /u/[id] (account info, profile link, sign out). Anons get
              a slimmer menu with sign-in/up + an inline rename for
              their per-session display name. */}
          {authUser && authUser.id && authUser.name ? (
            <UserMenu
              myId={authUser.id}
              name={authUser.name}
              email={authUser.email || ''}
              pro={!!authUser.pro}
              sessionRole={myRole}
            />
          ) : (
            <SessionAnonMenu
              displayName={displayName}
              code={code}
              role={myRole}
              onRenamed={onAnonRenamed}
            />
          )}
        </div>
      </header>

      {showSessionPanel && (
        <SessionPanel
          onClose={() => setShowSessionPanel(false)}
          onLeave={() => { setShowSessionPanel(false); router.push(leaveHref) }}
        />
      )}

      <main style={{flex:1,overflowY:'auto'}}>{children}</main>

      <nav style={{height:'calc(var(--nav-h) + 10px)',flexShrink:0,display:'flex',gap:10,borderTop:'1px solid var(--chrome-border)',background:'var(--chrome-nav-bg)',backdropFilter:'blur(18px)',zIndex:10,padding:'8px 14px calc(env(safe-area-inset-bottom,0px) + 8px)'}}>
        {navItems.map(({ label, path, icon }) => {
          const active = pathname === path
          return (
            <Link
              key={path}
              href={path}
              onClick={onGuardedLinkClick(path)}
              className={`nav-item${active ? ' active' : ''}`}
            >
              <span style={{fontSize:16,lineHeight:1}}>{icon}</span>
              <span>{label}</span>
            </Link>
          )
        })}
        <button
          onClick={() => guardedNav(() => router.push(leaveHref))}
          className="nav-item"
          style={{flex:1,color:'var(--fg-faint)',borderColor:'transparent',background:'transparent'}}
        >
          <span style={{fontSize:16,lineHeight:1}}>←</span>
          <span>Leave</span>
        </button>
      </nav>
    </div>
  )
}
