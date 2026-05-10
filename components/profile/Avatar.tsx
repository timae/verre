// Canonical user-avatar primitive. Renders a circular image when
// `imageUrl` is present, falling back to the user's initial letter on
// an accent-tinted background. Use this everywhere an avatar circle
// appears (ProfileHeader, ProfilePreviewInline, participant chips,
// feed authors). Surrounding chrome stays in the call site.

import type React from 'react'

interface Props {
  name: string
  imageUrl?: string | null
  // Either a fixed pixel size, or omit and pass `style` to let the
  // parent layout drive height (used by ProfilePreviewInline where
  // the avatar stretches to span the right column).
  size?: number
  style?: React.CSSProperties
  onClick?: () => void
}

export function Avatar({ name, imageUrl, size, style, onClick }: Props) {
  const initial = name[0]?.toUpperCase() ?? '?'
  const dim = size != null ? { width: size, height: size } : null
  // Letter font size scales with the circle when a fixed size is set;
  // when stretching, the parent passes a clamp() in `style`.
  const letterFontSize = size != null ? Math.round(size * 0.45) : undefined

  const base: React.CSSProperties = {
    borderRadius: '50%',
    background: 'rgba(200,150,60,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--accent)',
    fontWeight: 700,
    flexShrink: 0,
    overflow: 'hidden',
    cursor: onClick ? 'pointer' : undefined,
    ...dim,
    ...style,
  }

  if (imageUrl) {
    return (
      <div style={base} onClick={onClick}>
        <img src={imageUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
      </div>
    )
  }

  return (
    <div style={{ ...base, fontSize: letterFontSize }} onClick={onClick}>
      {initial}
    </div>
  )
}
