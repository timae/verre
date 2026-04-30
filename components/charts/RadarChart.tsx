'use client'
import { useMemo } from 'react'
import type { FlItem } from '@/lib/flavours'

const COLORS = [
  'rgba(200,150,60,.85)', 'rgba(122,175,200,.85)', 'rgba(184,64,64,.85)',
  'rgba(106,170,130,.85)', 'rgba(200,104,128,.85)', 'rgba(160,110,200,.85)',
]

interface Series { label: string; flavors: Record<string, number> }

interface Props {
  series: Series[]
  fl: FlItem[]
  size?: number
}

function ppts(n: number, r: number, cx: number, cy: number) {
  return Array.from({ length: n }, (_, i) => {
    const a = (Math.PI * 2 * i / n) - Math.PI / 2
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
  }).join(' ')
}

export function RadarChart({ series, fl, size = 240 }: Props) {
  const svg = useMemo(() => {
    const cx = size / 2, cy = size / 2, R = size / 2 - 44, n = fl.length
    const vpad = 20
    const vb = `${-vpad} ${-vpad} ${size + vpad * 2} ${size + vpad * 2}`
    let h = ''

    // Grid rings
    for (let l = 1; l <= 5; l++) {
      h += `<polygon points="${ppts(n, (R / 5) * l, cx, cy)}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="${l === 5 ? 'none' : '2,3'}"/>`
    }
    // Axes + labels
    fl.forEach((f, i) => {
      const a = (Math.PI * 2 * i / n) - Math.PI / 2
      h += `<line x1="${cx}" y1="${cy}" x2="${cx + R * Math.cos(a)}" y2="${cy + R * Math.sin(a)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`
      const lx = cx + (R + 24) * Math.cos(a), ly = cy + (R + 24) * Math.sin(a)
      const anch = Math.cos(a) > 0.15 ? 'start' : Math.cos(a) < -0.15 ? 'end' : 'middle'
      h += `<text x="${lx}" y="${ly}" text-anchor="${anch}" dominant-baseline="middle" font-size="7.5" fill="rgba(180,170,150,0.8)" font-family="Manrope,sans-serif" font-weight="700" letter-spacing="0.06em">${f.l.toUpperCase()}</text>`
    })

    // Each user's polygon
    series.forEach((s, si) => {
      const col = COLORS[si % COLORS.length]
      const pts = fl.map((f, i) => {
        const val = Math.max(0, Math.min(5, s.flavors[f.k] || 0))
        const a = (Math.PI * 2 * i / n) - Math.PI / 2
        const r = (R / 5) * val
        return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
      }).join(' ')
      const fillCol = col.replace('.85)', '.09)')
      h += `<polygon points="${pts}" fill="${fillCol}" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`
    })

    return { vb, h, w: size, ht: size }
  }, [series, fl, size])

  return (
    <svg viewBox={svg.vb} width={svg.w} height={svg.ht} xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: svg.h }} />
  )
}
