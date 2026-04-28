'use client'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'

type Session = {
  id: number; code: string; host_name: string; name: string | null
  created_at: string; joined_at: string; wines_rated: number; avg_score: string | null
}

export function HistoryClient() {
  const router = useRouter()
  const { data: sessions = [], isLoading } = useQuery<Session[]>({
    queryKey: ['me-sessions'],
    queryFn: () => fetch('/api/me/sessions').then(r => r.json()),
  })
  const { data: ratings = [] } = useQuery<{ wine_name: string; score: number; session_code: string }[]>({
    queryKey: ['me-ratings'],
    queryFn: () => fetch('/api/me/ratings').then(r => r.json()),
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
          const date = new Date(s.joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
          const hoursAgo = (Date.now() - new Date(s.joined_at).getTime()) / 3600000
          const active = hoursAgo < 47
          const wines = ratingsByCode[s.code] || []

          return (
            <div key={s.id} className="bg-bg2 border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-bold text-sm">{s.name || `Session ${s.code}`}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      active ? 'text-accent2 border-accent2/30 bg-accent2/10' : 'text-fg-faint border-border'
                    }`}>
                      {active ? 'active' : 'expired'}
                    </span>
                  </div>
                  <p className="text-xs text-fg-dim">{date} · {s.host_name} · {s.wines_rated} wines rated</p>
                </div>
                {active && (
                  <button
                    onClick={() => router.push(`/session/${s.code}`)}
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
