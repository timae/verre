'use client'
import { use, createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import type { WineMeta, RatingMeta } from '@/lib/session'

// ── Session context ─────────────────────────────────────────────
type SessionCtx = {
  code: string
  displayName: string
  isHost: boolean
  sessionMeta: { host: string; name: string; hostUserId: number | null } | null
  wines: WineMeta[]
  allRatings: Record<string, Record<string, RatingMeta>>
  myRatings: Record<string, RatingMeta>
  refresh: () => void
}
const Ctx = createContext<SessionCtx | null>(null)
export const useSession = () => {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession must be used inside SessionShell')
  return ctx
}

// ── Shell ───────────────────────────────────────────────────────
export function SessionShell({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ code: string }>
}) {
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

  const refresh = useCallback(() => {
    refetchWines()
    refetchRatings()
  }, [refetchWines, refetchRatings])

  // Record session visit
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
    { label: 'Wines', path: `/session/${C}`, icon: '🍷' },
    { label: 'Rate', path: `/session/${C}/rate`, icon: '⭐' },
    { label: 'Compare', path: `/session/${C}/compare`, icon: '◈' },
  ]

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex flex-col h-screen bg-[var(--bg)]">
        {/* Header */}
        <header className="flex items-center justify-between px-4 h-[var(--hdr-h)] border-b border-border/20 bg-bg/80 backdrop-blur-lg z-10 flex-shrink-0">
          <span className="text-accent font-extrabold tracking-widest text-lg uppercase">Verre</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-accent2 border border-accent2/30 px-2 py-1 rounded">
              {metaData?.name || C}
            </span>
            <span className="text-xs text-fg-dim">{displayName}</span>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">{children}</main>

        {/* Nav */}
        <nav className="flex gap-2 px-3 py-2 border-t border-border/20 bg-bg/90 backdrop-blur-lg flex-shrink-0">
          {navItems.map(({ label, path, icon }) => (
            <Link
              key={path} href={path}
              className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-bold transition-colors
                ${pathname === path
                  ? 'text-accent bg-accent/10 border border-accent/30'
                  : 'text-fg-dim border border-border/50'}`}
            >
              <span className="text-base">{icon}</span>
              <span>{label}</span>
            </Link>
          ))}
          <button
            onClick={() => router.push('/')}
            className="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-bold text-fg-faint border border-transparent"
          >
            <span className="text-base">←</span>
            <span>Leave</span>
          </button>
        </nav>
      </div>
    </Ctx.Provider>
  )
}
