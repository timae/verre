'use client'
import { Avatar } from './Avatar'
import { openLightbox } from '@/components/ui/ImageLightbox'

interface Props {
  name: string
  imageUrl: string | null | undefined
  size: number
}

// Non-owner-side avatar: tap to open the full-size lightbox if there's
// an image. Falls through to a plain (non-clickable) Avatar otherwise.
export function ZoomableAvatar({ name, imageUrl, size }: Props) {
  if (!imageUrl) {
    return <Avatar name={name} imageUrl={imageUrl} size={size} />
  }
  return <Avatar name={name} imageUrl={imageUrl} size={size} onClick={() => openLightbox(imageUrl, name)} />
}
