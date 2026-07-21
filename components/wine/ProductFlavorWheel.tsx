'use client'
import { useRef } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { resolveAxesColoured } from '@/lib/flavours'

// Community flavour wheel for the wine product page — the score-weighted
// structure aggregate from getProductAggregate. Mirrors ProfilePanelRatings:
// the wheel draws over the FULL structure axis set (dense frame, null → 0), so
// a never-tasted axis reads as an empty spoke rather than a gap.
export function ProductFlavorWheel({ flavors, label }: { flavors: Record<string, number | null>; label: string }) {
  const wheelRef = useRef<HTMLDivElement>(null)
  const hasData = Object.values(flavors).some(v => v != null)
  if (!hasData) {
    return (
      <p style={{ fontSize: 13, color: 'var(--fg-dim)', padding: '24px 8px', textAlign: 'center' }}>
        No flavour notes yet
      </p>
    )
  }
  const axes = resolveAxesColoured('wine', 'red')
  const dense = axes.reduce((o, f) => ({ ...o, [f.k]: flavors[f.k] == null ? 0 : (flavors[f.k] as number) }), {} as Record<string, number>)
  return (
    <div ref={wheelRef} onClick={() => openWheelLightbox(wheelRef, label)}
      style={{ display: 'flex', justifyContent: 'center', cursor: 'zoom-in' }}>
      <PolarChart flavors={dense} fl={axes} size={CHART_SIZE.DETAIL} />
    </div>
  )
}
