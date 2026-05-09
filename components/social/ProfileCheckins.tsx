'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckinCard } from './CheckinCard'
import { CheckinModal, type CopySource } from './CheckinModal'

type Checkin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string, number>|null; likeCount?: number
  createdAt?: string|Date|null; tags?: { id: number; name: string }[]
}

interface Props {
  initialCheckins: Checkin[]
  profileUserId: number
  profileUserName: string
  profileUserXp?: number
  myId: number | null
  viewerFollowsProfile?: boolean
}

export function ProfileCheckins({ initialCheckins, profileUserId, profileUserName, profileUserXp, myId, viewerFollowsProfile }: Props) {
  const router = useRouter()
  // Optimistic delete: hide ids client-side until the next router.refresh().
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set())
  const [copySource, setCopySource] = useState<Checkin | null>(null)
  const isOwnProfile = myId !== null && myId === profileUserId
  const author = { id: profileUserId, name: profileUserName, xp: profileUserXp }
  const visible = initialCheckins.filter(c => !hiddenIds.has(c.id))

  if (visible.length === 0) {
    return <p style={{ color: 'var(--fg-dim)', fontSize: 13, padding: '16px 0' }}>No public check-ins yet.</p>
  }

  return (
    <>
      {visible.map(c => (
        <CheckinCard
          key={c.id}
          checkin={c}
          author={author}
          showAuthor={true}
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
