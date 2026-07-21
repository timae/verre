'use client'
import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckinCard } from './CheckinCard'
import { SessionFeedCard } from './SessionFeedCard'
import { CheckinModal, type CopySource } from './CheckinModal'
import type { SessionFeedPayload } from '@/lib/feedTypes'

type CheckinPayload = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  productId?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string,number>; likeCount: number; liked?: boolean; createdAt?: string
  aromas?: { a: string; m: string | null; p?: boolean }[]
  viewerFollowsAuthor?: boolean
  tags?: { id: number; name: string }[]
}
type FeedItem =
  | { type: 'checkin'; createdAt: string; author: { id: number; name: string; xp: number; imageUrl?: string|null }; checkin: CheckinPayload }
  | { type: 'session'; createdAt: string; author: { id: number; name: string; xp: number; imageUrl?: string|null }; session: SessionFeedPayload }

type FeedResponse = { items: FeedItem[]; nextCursor: string | null }

export function FeedClient({ myId }: { myId: number }) {
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [extra, setExtra] = useState<FeedItem[]>([])
  const [showCheckin, setShowCheckin] = useState(false)
  const [copySource, setCopySource] = useState<CopySource | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  const { data, isLoading } = useQuery<FeedResponse>({
    queryKey: ['feed', refreshKey],
    queryFn: async () => {
      const d = await fetch('/api/feed').then(r => r.json()) as FeedResponse
      setNextCursor(d.nextCursor)
      setExtra([])
      return d
    },
  })

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const d = await fetch(`/api/feed?cursor=${encodeURIComponent(nextCursor)}`).then(r => r.json()) as FeedResponse
    setExtra(prev => [...prev, ...d.items])
    setNextCursor(d.nextCursor)
    setLoadingMore(false)
  }

  const handlePosted = useCallback(() => {
    setShowCheckin(false)
    setCopySource(null)
    setRefreshKey(k => k + 1)
  }, [])

  const items = [...(data?.items ?? []), ...extra]

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <h1 style={{ fontSize:24, fontWeight:700, color:'#F0E3C6' }}>Feed</h1>
        <button className="btn-s" onClick={() => setShowCheckin(true)}
          style={{ background:'rgba(200,150,60,0.1)', borderColor:'rgba(200,150,60,0.4)', color:'var(--accent)' }}>
          + check in a wine
        </button>
      </div>

      {isLoading && <p style={{ color:'var(--fg-dim)', fontSize:13 }}>Loading…</p>}

      {!isLoading && items.length === 0 && (
        <div className="panel" style={{ textAlign:'center', padding:'32px 16px' }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🌐</div>
          <p style={{ fontSize:13, color:'var(--fg-dim)', lineHeight:1.7 }}>
            Nothing here yet. Follow people from sessions or post your first check-in.
          </p>
          <button className="btn-p" onClick={() => setShowCheckin(true)}
            style={{ marginTop:16, maxWidth:240, marginLeft:'auto', marginRight:'auto' }}>
            → check in your first wine
          </button>
        </div>
      )}

      {items.map((item, i) => {
        if (item.type === 'checkin') {
          return (
            <CheckinCard
              key={`c-${item.checkin.id}-${i}`}
              checkin={item.checkin}
              author={item.author}
              showAuthor
              liked={item.checkin.liked}
              isOwn={item.author.id === myId}
              onDelete={async () => {
                const res = await fetch(`/api/checkins/${item.checkin.id}`, { method:'DELETE' })
                if (!res.ok) throw new Error(`delete failed: ${res.status}`)
                setRefreshKey(k => k + 1)
              }}
              onEdited={() => setRefreshKey(k => k + 1)}
              onCopy={item.author.id === myId || !item.checkin.viewerFollowsAuthor ? undefined : () => setCopySource({
                id: item.checkin.id,
                wineName: item.checkin.wineName,
                producer: item.checkin.producer,
                vintage: item.checkin.vintage,
                grape: item.checkin.grape,
                type: item.checkin.type,
                imageUrl: item.checkin.imageUrl,
                venueName: item.checkin.venueName,
                city: item.checkin.city,
                country: item.checkin.country,
                author: { id: item.author.id, name: item.author.name },
                taggedViewer: !!item.checkin.tags?.some(t => t.id === myId),
              })}
            />
          )
        }
        return (
          <SessionFeedCard
            key={`s-${item.session.id}-${i}`}
            session={item.session}
            author={item.author}
            createdAt={item.createdAt}
          />
        )
      })}

      {nextCursor && (
        <button className="btn-g" onClick={loadMore} disabled={loadingMore} style={{ marginTop:8 }}>
          {loadingMore ? 'loading…' : 'load more'}
        </button>
      )}

      {showCheckin && <CheckinModal onClose={() => setShowCheckin(false)} onPosted={handlePosted} />}
      {copySource && (
        <CheckinModal
          copyFromCheckin={copySource}
          onClose={() => setCopySource(null)}
          onPosted={handlePosted}
        />
      )}
    </div>
  )
}
