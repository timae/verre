// Canonical "wine identity" rendering — three lines, in order:
//   1. Name – Vintage
//   2. Producer
//   3. Grape
//
// Sites that display a wine (WineCard, RatingScreen header, Compare,
// CheckinCard, SavedWineModal) should use this component rather than
// re-implementing the field order inline. New variants extend the props
// rather than re-rolling the layout.
//
// Empty fields are skipped — no blank line if producer or grape is unset.
// Surrounding chrome (image, accent bar, score, like button, edit button,
// venue line, "revealed" badge, etc.) stays in the call site — this
// component owns the *identity text only*.

interface WineLike {
  name: string
  vintage?: string | null
  producer?: string | null
  grape?: string | null
}

type Size = 'compact' | 'card' | 'hero'

interface Props {
  wine: WineLike
  // 'compact' = list rows (WineCard, Compare, RatingScreen header)
  // 'card'    = medium emphasis (SavedWineModal)
  // 'hero'    = headline emphasis (CheckinCard with photo / no photo)
  size?: Size
  // Optional prefix rendered inline before the wine name (e.g. a "revealed"
  // badge in RatingScreen, or a wine-type icon in Compare). Keeps the call
  // site in control of context-specific decoration without forcing the
  // identity layout to change.
  titlePrefix?: React.ReactNode
}

const SIZES: Record<Size, { title: number; weight: number; subtitle: number }> = {
  compact: { title: 13, weight: 700, subtitle: 10 },
  card:    { title: 16, weight: 800, subtitle: 11 },
  hero:    { title: 22, weight: 800, subtitle: 11 },
}

export function WineIdentity({ wine, size = 'compact', titlePrefix }: Props) {
  const dims = SIZES[size]

  // 'hero' uses clamp() so it scales with viewport — feed cards on small
  // phones look reasonable while desktop gets the full headline weight.
  const titleStyle: React.CSSProperties = size === 'hero'
    ? { fontSize: 'clamp(16px,4vw,22px)', fontWeight: dims.weight, color: 'var(--fg)', lineHeight: 1.15, margin: 0, wordBreak: 'break-word' }
    : { fontSize: dims.title, fontWeight: dims.weight, color: 'var(--fg)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

  const lineStyle: React.CSSProperties = {
    fontSize: dims.subtitle, color: 'var(--fg-dim)', marginTop: 2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }

  return (
    <>
      <div style={titleStyle}>
        {titlePrefix}
        {wine.name}
        {wine.vintage && (
          <span style={{ fontWeight: 400, color: 'var(--fg-dim)', marginLeft: 6 }}>– {wine.vintage}</span>
        )}
      </div>
      {wine.producer && <div style={lineStyle}>{wine.producer}</div>}
      {wine.grape && <div style={lineStyle}>{wine.grape}</div>}
    </>
  )
}
