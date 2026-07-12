import type { CSSProperties } from 'react'
import { AROMA_FAMILIES, getAromaNode, aromaModifierDisplay } from '@verre/core'
import { aromaFamilyColour } from '@/lib/flavours'

// Read-only aroma chips — the WEB twin of the native AromaReadChips
// (apps/mobile/src/components/scoring/aroma/AromaReadChips.tsx; there is no
// shared RN/web component layer, so the display rules are mirrored here).
// Renders someone's stored selections in the shared display order (pronounced
// first, then grouped by family in taxonomy order — aroma-layer.md §7) as
// family-tinted badges: tint fill + family-coloured words, Pronounced adds a
// border. Read-only by design: no input, no refine (web aroma INPUT is
// deferred to the web redesign, §6). No blind fork anywhere — aromas are the
// taster's own perception, never wine identity (§7), so they render on a
// blind-redacted wine exactly like score/flavors.
//
// Deviation from the native badge ruling (flagged): native words are
// `readableSolid` (the 100% palette colour wherever it clears 3:1, ink-pulled
// only past that — measured per fill). The web keeps it modest (slated for
// redesign): words + border are a flat `color-mix(in srgb, <family> 62%,
// var(--fg))` — the same pull-toward-ink direction, theme-aware via var(--fg)
// (lightens dark families on the dark theme, darkens bright ones on light)
// without porting the contrast math.

// Wire shape (`p?: boolean`) — matches SessionFeedWine.aromas / the checkin
// payloads, looser than core's canonical `p?: true`.
type AromaSel = { a: string; m: string | null; p?: boolean }

// Display order — mirrors the native displayOrder (parts.tsx): PRONOUNCED
// first, then clustered by FAMILY in taxonomy order, insertion order within
// a family (stable sort). Display-only; the stored array keeps insertion order.
const FAMILY_ORDER = new Map(AROMA_FAMILIES.map((f, i) => [f.id, i]))
function displayOrder(value: AromaSel[]): AromaSel[] {
  const familyIdx = (a: string) => FAMILY_ORDER.get(getAromaNode(a)?.family.id ?? '') ?? AROMA_FAMILIES.length
  return [...value].sort((x, y) => {
    const p = Number(!!y.p) - Number(!!x.p)
    if (p) return p
    return familyIdx(x.a) - familyIdx(y.a)
  })
}

// "Strawberry, jammy" / "Fig, dried" / "Berry" — aroma first, modifier second
// via the per-leaf display word (mirrors the native selectionLabel).
function selectionLabel(sel: AromaSel): string {
  const node = getAromaNode(sel.a)
  if (!node) return sel.a
  const name = node.label.charAt(0).toUpperCase() + node.label.slice(1)
  return sel.m ? `${name}, ${aromaModifierDisplay(sel.a, sel.m)}` : name
}

export function AromaReadChips({ aromas, style }: { aromas?: AromaSel[] | null; style?: CSSProperties }) {
  if (!aromas?.length) return null
  // Unknown node id (defensive — the write boundary rejected unknowns):
  // render nothing rather than throw, per the core read-path posture.
  const shown = displayOrder(aromas).filter(s => getAromaNode(s.a))
  if (!shown.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, ...style }}>
      {shown.map(sel => {
        const family = getAromaNode(sel.a)!.family.id
        const c = aromaFamilyColour(family)
        const words = `color-mix(in srgb, ${c} 62%, var(--fg))`
        return (
          <span
            key={`${sel.a}|${sel.m ?? ''}`}
            style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '3px 9px', borderRadius: 999,
              fontSize: 10.5, fontWeight: 600, lineHeight: 1.5,
              color: words,
              background: `${c}29`, // family tint fill (~16% alpha)
              // The ONLY border in the system marks Pronounced; transparent
              // otherwise so layout stays stable (native chip anatomy).
              border: `1px solid ${sel.p ? words : 'transparent'}`,
            }}
          >
            {selectionLabel(sel)}
          </span>
        )
      })}
    </div>
  )
}
