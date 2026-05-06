'use client'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { authedFetch } from '@/lib/authedFetch'
import { formatCode } from '@/lib/sessionCode'

type Session = {
  id: number; code: string; host_name: string; name: string | null
  created_at: string; joined_at: string; wines_rated: number; avg_score: string | null
  date_from: string | null; address: string | null
  ttl_seconds: number; lifespan: string | null
}

function formatTTL(seconds: number, lifespan: string | null): string {
  if (lifespan === 'unlimited') return '∞ unlimited'
  if (seconds <= 0) return 'expired'
  const days  = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins  = Math.floor((seconds % 3600) / 60)
  if (days  > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

export function HistoryClient() {
  const router = useRouter()
  const { data: authSession } = useQuery({ queryKey: ['auth-me'], queryFn: () => fetch('/api/auth/session').then(r=>r.json()), staleTime: 60_000 })
  const { data: sessions = [], isLoading } = useQuery<Session[]>({
    queryKey: ['me-sessions'],
    queryFn: () => authedFetch<Session[]>('/api/me/sessions'),
  })
  const { data: ratings = [] } = useQuery<{ wine_name: string; score: number; session_code: string }[]>({
    queryKey: ['me-ratings'],
    queryFn: () => authedFetch<{ wine_name: string; score: number; session_code: string }[]>('/api/me/ratings'),
  })

  const ratingsByCode = ratings.reduce((acc, r) => {
    if (!acc[r.session_code]) acc[r.session_code] = []
    acc[r.session_code].push(r)
    return acc
  }, {} as Record<string, typeof ratings>)

  if (isLoading) return <p className="text-fg-dim text-sm">Loading…</p>
  if (!sessions.length) return (
    <p className="text-fg-dim text-sm py-8">No tasting history yet. Join a session to begin.</p>
  )

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Tasting history</h1>
      <div className="space-y-3">
        {sessions.map(s => {
          const date = s.date_from
            ? new Date(s.date_from).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : new Date(s.joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
          const active = s.lifespan === 'unlimited' || s.ttl_seconds > 0
          const ttlLabel = formatTTL(s.ttl_seconds, s.lifespan)
          const wines = ratingsByCode[s.code] || []

          return (
            <div key={s.id} className="bg-bg2 border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-bold text-sm">{s.name || `Session ${formatCode(s.code)}`}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      active ? 'text-accent2 border-accent2/30 bg-accent2/10' : 'text-fg-faint border-border'
                    }`}>
                      {ttlLabel}
                    </span>
                  </div>
                  <p className="text-xs text-fg-dim">{date}{s.address ? ` · ${s.address}` : ''} · {s.host_name} · {s.wines_rated} wines rated</p>
                </div>
                {active && (
                  <button
                    onClick={() => {
                    const name = authSession?.user?.name || ''
                    const q = name ? `?name=${encodeURIComponent(name)}` : ''
                    router.push(`/session/${s.code}${q}`)
                  }}
                    className="text-xs text-accent border border-accent/30 px-3 py-1.5 rounded-lg flex-shrink-0"
                  >
                    → rejoin
                  </button>
                )}
              </div>
              {wines.length > 0 && (
                <div className="space-y-1">
                  {wines.slice(0, 4).map((r, i) => (
                    <div key={i} className="flex justify-between text-xs text-fg-dim">
                      <span className="truncate">{r.wine_name}</span>
                      <span className="text-accent ml-2 flex-shrink-0">{r.score}★</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
