'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckinCard } from './CheckinCard'
import { CheckinModal, type CopySource } from './CheckinModal'

type Checkin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string, number>|null; likeCount?: number; liked?: boolean
  createdAt?: string|Date|null; tags?: { id: number; name: string }[]
}

// Phase 2 stub for a session feed_item on the profile. Phase 3 will replace
// this with a proper SessionFeedCard that fans out per-wine ratings.
export type SessionPost = {
  id: number
  sessionId: number | null
  sessionName: string | null
  deleted: boolean
  blind: boolean
  createdAt?: string | Date | null
  likeCount?: number
  liked?: boolean
}

interface Props {
  initialCheckins: Checkin[]
  initialSessionPosts?: SessionPost[]
  profileUserId: number
  profileUserName: string
  profileUserXp?: number
  profileUserImageUrl?: string | null
  myId: number | null
  viewerFollowsProfile?: boolean
}

export function ProfileCheckins({ initialCheckins, initialSessionPosts = [], profileUserId, profileUserName, profileUserXp, profileUserImageUrl, myId, viewerFollowsProfile }: Props) {
  const router = useRouter()
  // Optimistic delete: hide ids client-side until the next router.refresh().
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set())
  const [copySource, setCopySource] = useState<Checkin | null>(null)
  const isOwnProfile = myId !== null && myId === profileUserId
  const author = { id: profileUserId, name: profileUserName, xp: profileUserXp, imageUrl: profileUserImageUrl }
  const visible = initialCheckins.filter(c => !hiddenIds.has(c.id))

  if (visible.length === 0 && initialSessionPosts.length === 0) {
    return <p style={{ color: 'var(--fg-dim)', fontSize: 13, padding: '16px 0' }}>No public check-ins yet.</p>
  }

  return (
    <>
      {initialSessionPosts.map(s => (
        // Phase 2 stub. Phase 3 will replace with SessionFeedCard fan-out.
        <div key={`s-${s.id}`} className="panel" style={{ marginBottom: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4 }}>
            {profileUserName} had a tasting
          </div>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>
            {s.deleted ? '[deleted session]' : (s.sessionName || 'Untitled session')}
          </div>
        </div>
      ))}
      {visible.map(c => (
        <CheckinCard
          key={c.id}
          checkin={c}
          author={author}
          showAuthor={true}
          liked={c.liked ?? false}
          isOwn={isOwnProfile}
          onDelete={isOwnProfile ? async () => {
            const res = await fetch(`/api/checkins/${c.id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`delete failed: ${res.status}`)
            setHiddenIds(prev => { const next = new Set(prev); next.add(c.id); return next })
            router.refresh()
          } : undefined}
          onEdited={isOwnProfile ? () => router.refresh() : undefined}
          onCopy={isOwnProfile || myId === null || !viewerFollowsProfile ? undefined : () => setCopySource(c)}
        />
      ))}
      {copySource && (
        <CheckinModal
          copyFromCheckin={{
            id: copySource.id,
            wineName: copySource.wineName,
            producer: copySource.producer,
            vintage: copySource.vintage,
            grape: copySource.grape,
            type: copySource.type,
            imageUrl: copySource.imageUrl,
            venueName: copySource.venueName,
            city: copySource.city,
            country: copySource.country,
            author: { id: profileUserId, name: profileUserName },
            taggedViewer: !!copySource.tags?.some(t => t.id === myId),
          } satisfies CopySource}
          onClose={() => setCopySource(null)}
          onPosted={() => { setCopySource(null); router.refresh() }}
        />
      )}
    </>
  )
}
