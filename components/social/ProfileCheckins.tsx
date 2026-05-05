'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckinCard } from './CheckinCard'

type Checkin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  flavors?: Record<string, number>|null; likeCount?: number
  createdAt?: string|Date|null; tags?: { id: number; name: string }[]
}

interface Props {
  initialCheckins: Checkin[]
  // The id and identity of the user whose profile is being viewed.
  profileUserId: number
  profileUserName: string
  profileUserXp?: number
  // The viewer's id (the logged-in user). null when not signed in.
  myId: number | null
}

// Client wrapper around the profile check-ins list. The profile page itself
// is a server component — this carries the small bit of client state needed
// so the profile owner can edit/delete their own check-ins (matching the
// feed UX).
//
// On delete: card is removed from local state immediately for snappy UX.
// On edit: router.refresh() re-runs the server component with fresh data
// so the card reflects the saved changes without a full page reload.
//
// Cards render with showAuthor=true so the edit button (which lives inside
// the author row of CheckinCard) is reachable on the profile owner's view.
export function ProfileCheckins({ initialCheckins, profileUserId, profileUserName, profileUserXp, myId }: Props) {
  const router = useRouter()
  // Render initialCheckins directly (so router.refresh() re-pushes the
  // freshest data without state-sync gymnastics). For optimistic delete
  // before the next server roundtrip, mask hidden ids out via a Set —
  // that survives prop changes naturally and gets reconciled when the
  // server next re-fetches.
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set())
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
        />
      ))}
    </>
  )
}
