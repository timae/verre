'use client'
import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckinCard } from './CheckinCard'
import { CheckinModal } from './CheckinModal'
import { getLevel } from '@/lib/badges'
import { timeAgo } from '@/lib/timeAgo'
import Link from 'next/link'

type CheckinPayload = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string,number>; likeCount: number; liked?: boolean; createdAt?: string
}
type FeedItem =
  | { type: 'checkin'; createdAt: string; author: { id: number; name: string; xp: number }; checkin: CheckinPayload }
  | { type: 'badge';   createdAt: string; author: { id: number; name: string }; badge: { id: string; name: string; icon: string; description: string; xp_reward: number } }

type FeedResponse = { items: FeedItem[]; nextCursor: string | null }

export function FeedClient({ myId }: { myId: number }) {
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [extra, setExtra] = useState<FeedItem[]>([])
  const [showCheckin, setShowCheckin] = useState(false)
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
            />
          )
        }
        const badge = item.badge
        return (
          <div key={`b-${badge.id}-${i}`} className="panel" style={{ marginBottom:10, display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ fontSize:28, flexShrink:0 }}>{badge.icon}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:11, color:'var(--fg-dim)', marginBottom:2 }}>
                <Link href={`/u/${item.author.id}`} style={{ color:'var(--accent)', textDecoration:'none', fontWeight:700 }}>{item.author.name}</Link>
                {' '}earned a badge
              </div>
              <div style={{ fontWeight:700, fontSize:13 }}>{badge.name}</div>
              <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:2 }}>{badge.description}</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontSize:10, color:'var(--accent)', fontFamily:'var(--mono)' }}>+{badge.xp_reward} xp</div>
              <div style={{ fontSize:10, color:'var(--fg-dim)', fontFamily:'var(--mono)', marginTop:3 }}>{timeAgo(item.createdAt)}</div>
            </div>
          </div>
        )
      })}

      {nextCursor && (
        <button className="btn-g" onClick={loadMore} disabled={loadingMore} style={{ marginTop:8 }}>
          {loadingMore ? 'loading…' : 'load more'}
        </button>
      )}

      {showCheckin && <CheckinModal onClose={() => setShowCheckin(false)} onPosted={handlePosted} />}
    </div>
  )
}
