'use client'
import { useQuery } from '@tanstack/react-query'

type Bookmark = {
  wine_id: string; name: string; producer: string | null; vintage: string | null
  style: string | null; image_url: string | null; session_code: string
}

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function SavedClient() {
  const { data: bookmarks = [], isLoading } = useQuery<Bookmark[]>({
    queryKey: ['me-bookmarks'],
    queryFn: () => fetch('/api/me/bookmarks').then(r => r.json()),
  })

  if (isLoading) return <p className="text-fg-dim text-sm">Loading…</p>
  if (!bookmarks.length) return (
    <p className="text-fg-dim text-sm py-8">No saved wines yet. Tap ☆ on any wine detail to save it.</p>
  )

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Saved wines</h1>
      <div className="flex flex-col gap-2">
        {bookmarks.map(b => (
          <div key={b.wine_id} className="bg-bg2 border border-border rounded-xl p-3.5 flex items-center gap-3">
            {b.image_url ? (
              <img src={b.image_url} alt={b.name} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-bg3 flex items-center justify-center text-xl flex-shrink-0">
                {ICO[b.style || ''] || '🍷'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm truncate">{b.name}</p>
              <p className="text-xs text-fg-dim">{[b.producer, b.vintage].filter(Boolean).join(' · ')} · {b.session_code}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
