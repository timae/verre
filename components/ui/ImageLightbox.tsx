'use client'
import { useEffect, useState } from 'react'

export type LightboxEvent = CustomEvent<{ src: string; alt?: string }>

declare global {
  interface WindowEventMap {
    'open-lightbox': LightboxEvent
  }
}

export function openLightbox(src: string, alt?: string) {
  window.dispatchEvent(new CustomEvent('open-lightbox', { detail: { src, alt } }))
}

export function ImageLightbox() {
  const [state, setState] = useState<{ src: string; alt?: string } | null>(null)

  useEffect(() => {
    const handler = (e: LightboxEvent) => setState(e.detail)
    window.addEventListener('open-lightbox', handler)
    return () => window.removeEventListener('open-lightbox', handler)
  }, [])

  useEffect(() => {
    if (!state) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setState(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [state])

  if (!state) return null

  return (
    <div
      onClick={() => setState(null)}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, cursor: 'zoom-out',
      }}
    >
      {/* Close button */}
      <button
        onClick={() => setState(null)}
        style={{
          position: 'absolute', top: 16, right: 16,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
          color: '#fff', fontSize: 18, lineHeight: 1, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ✕
      </button>

      <img
        src={state.src}
        alt={state.alt || ''}
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '100%', maxHeight: '90vh',
          objectFit: 'contain', borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          cursor: 'default',
        }}
      />

      {state.alt && (
        <div style={{
          position: 'absolute', bottom: 24, left: 0, right: 0,
          textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.5)',
          fontFamily: 'var(--mono)', letterSpacing: '0.06em',
        }}>
          {state.alt}
        </div>
      )}
    </div>
  )
}
