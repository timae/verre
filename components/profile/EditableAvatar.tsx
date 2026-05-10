'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar } from './Avatar'
import { AvatarEditor } from './AvatarEditor'

interface Props {
  name: string
  imageUrl: string | null
  size: number
}

export function EditableAvatar({ name, imageUrl, size }: Props) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  function handleSaved() {
    setOpen(false)
    // SSR re-render so the new (or removed) avatar shows up everywhere
    // the URL is embedded — header, feed, participant list.
    router.refresh()
  }

  return (
    <>
      <Avatar name={name} imageUrl={imageUrl} size={size} onClick={() => setOpen(true)} />
      {open && (
        <AvatarEditor
          currentUrl={imageUrl}
          onClose={() => setOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  )
}
