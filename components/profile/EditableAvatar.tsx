'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Avatar } from './Avatar'
import { AvatarEditor } from './AvatarEditor'

interface Props {
  userId: number
  name: string
  imageUrl: string | null
  size: number
}

export function EditableAvatar({ userId, name, imageUrl, size }: Props) {
  const [open, setOpen] = useState(false)
  // Optimistic override — set on save with the freshly-rendered crop
  // data URL so the new avatar shows up instantly while router.refresh
  // and any in-flight queries catch up. Cleared back to null on reset.
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const router = useRouter()
  const queryClient = useQueryClient()

  function handleSaved(newDataUrl: string | null) {
    setOpen(false)
    setOptimistic(newDataUrl)
    // SSR re-render so the new (or removed) avatar shows up everywhere
    // the URL is embedded — header, feed, participant list.
    router.refresh()
    // Invalidate the in-tasting profile cache (ProfilePreviewInline
    // and UserProfileModal share key ['user-profile', userId]) so a
    // tap on the same row picks up the new URL within a render tick
    // instead of after the 30s staleTime expires.
    queryClient.invalidateQueries({ queryKey: ['user-profile', userId] })
  }

  // Prefer the optimistic data-URL if we just saved; once router.refresh
  // gives us a fresh prop with the real S3 URL we drop the override.
  const displayUrl = optimistic ?? imageUrl

  return (
    <>
      <Avatar name={name} imageUrl={displayUrl} size={size} onClick={() => setOpen(true)} />
      {open && (
        <AvatarEditor
          name={name}
          currentUrl={imageUrl}
          onClose={() => setOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  )
}
