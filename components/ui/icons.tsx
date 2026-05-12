// Stroke-based inline SVG icon set. 1.5px stroke, `currentColor`,
// `viewBox="0 0 24 24"`. Sized by the `size` prop (default 18px).
//
// Use these instead of emoji glyphs for chrome icons (close, edit,
// trash, etc.) — emoji render inconsistently across platforms and
// can't take on `var(--accent)` / `var(--fg-dim)` tinting. Emoji are
// still fine where they ARE the content (wine-type icon in the
// AddWineModal type chips, food emoji disambiguating display names).

interface IconProps {
  size?: number
  stroke?: number
  className?: string
  style?: React.CSSProperties
}

function Icon({ size = 18, stroke = 1.5, className, style, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, display: 'inline-block', ...style }}
    >
      {children}
    </svg>
  )
}

export function HeartIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...p}>
      <path
        d="M12 20s-7-4.5-9-9c-1.5-3.4 1-7 4.5-7 2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4c3.5 0 6 3.6 4.5 7-2 4.5-9 9-9 9z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Icon>
  )
}

export function CloseIcon(p: IconProps) {
  return <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>
}

export function MoreIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="5"  cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function PinIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z" />
      <circle cx="12" cy="10" r="2.5" />
    </Icon>
  )
}

export function FlaskIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M9 3h6M10 3v6.5L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-8.5V3" />
      <path d="M7.5 14h9" />
    </Icon>
  )
}

export function LinkIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </Icon>
  )
}

export function PencilIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </Icon>
  )
}

export function TrashIcon(p: IconProps) {
  return <Icon {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Icon>
}

export function ArrowLeftIcon(p: IconProps) {
  return <Icon {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Icon>
}

export function ArrowRightIcon(p: IconProps) {
  return <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>
}

export function StarIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...p}>
      <path
        d="M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.6L12 17.5 6.1 20.7l1.3-6.6L2.5 9.5l6.6-.8L12 2.5z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Icon>
  )
}

export function CheckIcon(p: IconProps) {
  return <Icon {...p}><path d="M5 12l4.5 4.5L19 7" /></Icon>
}

export function ResetIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Icon>
  )
}

// Glass shapes per wine type. Each fits the 64×96 viewBox.
// `fillColor` paints the liquid; the rim/stem/highlight overlay sits on top.
// Used by the WineInfoPane hero decoration.
interface GlassProps { type: string; fillColor: string; width?: number; height?: number }

const GLASS_STROKE = 'rgba(212,207,190,0.35)'
const GLASS_STROKE_PROPS = {
  stroke: GLASS_STROKE,
  strokeWidth: 1.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function WineGlass({ type, fillColor, width = 60, height = 90 }: GlassProps) {
  return (
    <svg width={width} height={height} viewBox="0 0 64 96" fill="none">
      {type === 'red' && <>
        <path d="M12 6 Q12 38 32 42 Q52 38 52 6 Z" fill={fillColor} />
        <path d="M12 6 Q12 38 32 42 Q52 38 52 6 Z M12 6 L52 6 M32 42 L32 80 M20 80 L44 80" {...GLASS_STROKE_PROPS} />
        <ellipse cx="22" cy="14" rx="6" ry="1.5" fill="rgba(255,255,255,0.18)" />
      </>}
      {type === 'white' && <>
        <path d="M18 6 Q18 36 32 40 Q46 36 46 6 Z" fill={fillColor} />
        <path d="M18 6 Q18 36 32 40 Q46 36 46 6 Z M18 6 L46 6 M32 40 L32 80 M22 80 L42 80" {...GLASS_STROKE_PROPS} />
        <ellipse cx="25" cy="14" rx="4" ry="1.2" fill="rgba(255,255,255,0.18)" />
      </>}
      {type === 'spark' && <>
        <path d="M25 6 L25 56 Q25 60 32 60 Q39 60 39 56 L39 6 Z" fill={fillColor} />
        <path d="M25 6 L25 56 Q25 60 32 60 Q39 60 39 56 L39 6 Z M25 6 L39 6 M32 60 L32 80 M24 80 L40 80" {...GLASS_STROKE_PROPS} />
        <circle cx="32" cy="50" r="0.8" fill="rgba(255,255,255,0.5)" />
        <circle cx="30" cy="42" r="0.6" fill="rgba(255,255,255,0.4)" />
        <circle cx="33" cy="34" r="0.6" fill="rgba(255,255,255,0.4)" />
        <circle cx="31" cy="26" r="0.5" fill="rgba(255,255,255,0.3)" />
      </>}
      {type === 'rose' && <>
        <path d="M16 6 Q16 36 32 40 Q48 36 48 6 Z" fill={fillColor} />
        <path d="M16 6 Q16 36 32 40 Q48 36 48 6 Z M16 6 L48 6 M32 40 L32 80 M22 80 L42 80" {...GLASS_STROKE_PROPS} />
        <ellipse cx="24" cy="14" rx="5" ry="1.3" fill="rgba(255,255,255,0.18)" />
      </>}
      {type === 'nonalc' && <>
        <path d="M18 30 L18 78 Q18 84 24 84 L40 84 Q46 84 46 78 L46 30 Z" fill={fillColor} />
        <path d="M18 30 L18 78 Q18 84 24 84 L40 84 Q46 84 46 78 L46 30 Z M18 30 L46 30" {...GLASS_STROKE_PROPS} />
        <ellipse cx="24" cy="36" rx="3" ry="1" fill="rgba(255,255,255,0.2)" />
      </>}
    </svg>
  )
}
