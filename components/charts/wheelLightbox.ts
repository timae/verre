'use client'
import type { RefObject } from 'react'
import { openLightbox } from '@/components/ui/ImageLightbox'

// Open a flavour-wheel chart full-screen via the existing ImageLightbox.
//
// PolarChart renders an inline SVG. We clone it, paint a theme-matching
// background + padding so it looks framed when the lightbox blows it up,
// serialize to a blob URL, and hand it off to openLightbox(). The blob
// is revoked after 60s so we don't leak memory if the page stays open.
//
// Use on any read-only chart surface where tap-to-expand makes sense
// (feed cards, saved-wine modal, profile aggregate). Skip it on
// editing surfaces (CheckinModal sliders) and already-large surfaces
// (RatingScreen, Compare).
export function openWheelLightbox(ref: RefObject<HTMLDivElement | null>, label: string) {
  const svg = ref.current?.querySelector('svg')
  if (!svg) return
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
  const bg = isDark ? '#0E0E0C' : '#F6F0E6'
  const clone = svg.cloneNode(true) as SVGElement
  clone.setAttribute('style', `background:${bg};border-radius:16px;padding:24px;`)
  const data = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([data], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  openLightbox(url, label + ' — flavour profile')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
