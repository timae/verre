'use client'
import { useMemo } from 'react'
import type { FlItem } from '@/lib/flavours'

interface Props {
  flavors: Record<string, number>
  fl: FlItem[]
  size?: number
  className?: string
}

function arcSeg(cx: number, cy: number, r1: number, r2: number, a1d: number, a2d: number, fill: string, opacity: number) {
  const a1 = (a1d * Math.PI) / 180
  const a2 = (a2d * Math.PI) / 180
  const lg = a2d - a1d > 180 ? 1 : 0
  const x1 = cx + r1 * Math.cos(a1), y1 = cy + r1 * Math.sin(a1)
  const x2 = cx + r2 * Math.cos(a1), y2 = cy + r2 * Math.sin(a1)
  const x3 = cx + r2 * Math.cos(a2), y3 = cy + r2 * Math.sin(a2)
  const x4 = cx + r1 * Math.cos(a2), y4 = cy + r1 * Math.sin(a2)
  return `<path d="M${x1},${y1}L${x2},${y2}A${r2},${r2},0,${lg},1,${x3},${y3}L${x4},${y4}A${r1},${r1},0,${lg},0,${x1},${y1}Z" fill="${fill}" opacity="${opacity}"/>`
}

export function PolarChart({ flavors, fl, size = 300, className }: Props) {
  const svg = useMemo(() => {
    const cx = size / 2, cy = size / 2, n = fl.length
    const iR = size * 0.10, oR = size * 0.37, lR = size * 0.44
    const gap = 3, seg = 360 / n - gap
    const vpad = 30
    const vb = `${-vpad} ${-vpad} ${size + vpad * 2} ${size + vpad * 2}`

    let h = ''
    // scale rings
    for (let ring = 1; ring <= 5; ring++) {
      const r = iR + (oR - iR) * ring / 5
      h += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="0.6" stroke-dasharray="1.5,2.5"/>`
    }

    fl.forEach((f, i) => {
      const val = Math.max(0, Math.min(5, flavors[f.k] || 0))
      const a1 = (360 / n * i) - 90 + gap / 2
      const a2 = a1 + seg
      const mid = (a1 + a2) / 2
      const mRad = (mid * Math.PI) / 180

      h += arcSeg(cx, cy, iR, oR, a1, a2, f.c, 0.13)
      if (val > 0) {
        const vr = iR + (oR - iR) * val / 5
        h += arcSeg(cx, cy, iR, vr, a1, a2, f.c, 0.85)
      }

      const lx = cx + lR * Math.cos(mRad)
      const ly = cy + lR * Math.sin(mRad)
      const anch = Math.cos(mRad) > 0.2 ? 'start' : Math.cos(mRad) < -0.2 ? 'end' : 'middle'
      h += `<text x="${lx}" y="${ly}" text-anchor="${anch}" dominant-baseline="middle" font-size="7.5" fill="rgba(180,170,150,0.8)" font-family="Manrope,sans-serif" font-weight="700" letter-spacing="0.06em">${f.l.toUpperCase()}</text>`
    })

    return { vb, h, w: size, ht: size }
  }, [flavors, fl, size])

  return (
    <svg
      viewBox={svg.vb}
      style={{ width: '100%', height: 'auto', maxWidth: size, display: 'block', margin: '0 auto' }}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      dangerouslySetInnerHTML={{ __html: svg.h }}
    />
  )
}
