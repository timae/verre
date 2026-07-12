'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckinCard } from './CheckinCard'
import { SessionFeedCard } from './SessionFeedCard'
import { CheckinModal, type CopySource } from './CheckinModal'

type Checkin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string, number>|null; likeCount?: number; liked?: boolean
  aromas?: { a: string; m: string | null; p?: boolean }[]|null
  createdAt?: string|Date|null; tags?: { id: number; name: string }[]
}

// Re-exports the canonical session-feed payload, plus the optional
// `createdAt` the renderer uses for chronological merging with the
// standalone check-in list.
import type { SessionFeedPayload } from '@/lib/feedTypes'
export type SessionPost = SessionFeedPayload & { createdAt?: string | Date | null }

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

  // Merge standalone check-ins and session stubs into one chronological
  // list — matches FeedClient's behaviour so a 6-month-old session post
  // doesn't sit on top of yesterday's check-in. Tagged union by `__kind`
  // so the dispatch below picks the right renderer.
  type Mixed =
    | ({ __kind: 'checkin'; __ts: number } & Checkin)
    | ({ __kind: 'session'; __ts: number } & SessionPost)
  const mixed: Mixed[] = [
    ...visible.map(c => ({
      ...c,
      __kind: 'checkin' as const,
      __ts: c.createdAt ? new Date(c.createdAt).getTime() : 0,
    })),
    ...initialSessionPosts.map(s => ({
      ...s,
      __kind: 'session' as const,
      __ts: s.createdAt ? new Date(s.createdAt).getTime() : 0,
    })),
  ].sort((a, b) => b.__ts - a.__ts)

  return (
    <>
      {mixed.map(item => {
        if (item.__kind === 'session') {
          return (
            <SessionFeedCard
              key={`s-${item.id}`}
              session={item}
              author={author}
              createdAt={item.createdAt}
            />
          )
        }
        const c = item
        return (
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
        )
      })}
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
