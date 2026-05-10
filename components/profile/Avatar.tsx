// Canonical user-avatar primitive. Renders a circular image when
// `imageUrl` is present, falling back to the user's initial letter on
// an accent-tinted background. Use this everywhere an avatar circle
// appears (ProfileHeader, ProfilePreviewInline, participant chips,
// feed authors). Surrounding chrome stays in the call site.

interface Props {
  name: string
  imageUrl?: string | null
  size: number
  onClick?: () => void
}

export function Avatar({ name, imageUrl, size, onClick }: Props) {
  const initial = name[0]?.toUpperCase() ?? '?'
  const letterFontSize = Math.round(size * 0.45)

  const base = {
    width: size,
    height: size,
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
  } as const

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
