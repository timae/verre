'use client'
import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, type PanInfo } from 'framer-motion'

export type LightboxEvent = CustomEvent<{ src: string; alt?: string }>

declare global {
  interface WindowEventMap {
    'open-lightbox': LightboxEvent
  }
}

export function openLightbox(src: string, alt?: string) {
  window.dispatchEvent(new CustomEvent('open-lightbox', { detail: { src, alt } }))
}

const DISMISS_DISTANCE = 120
const DISMISS_VELOCITY = 600

export function ImageLightbox() {
  const [state, setState] = useState<{ src: string; alt?: string } | null>(null)
  const y = useMotionValue(0)

  useEffect(() => {
    const handler = (e: LightboxEvent) => { y.set(0); setState(e.detail) }
    window.addEventListener('open-lightbox', handler)
    return () => window.removeEventListener('open-lightbox', handler)
  }, [y])

  useEffect(() => {
    if (!state) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setState(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [state])

  function onDragEnd(_: unknown, info: PanInfo) {
    // Swipe-down only — swipe-up snaps back so users don't dismiss by reflex.
    if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) {
      setState(null)
    }
  }

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          onClick={() => setState(null)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, cursor: 'zoom-out',
          }}
        >
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

          {/* touch-action: pinch-zoom keeps native pinch alive — when the
              browser claims the gesture it fires pointercancel, which ends
              framer-motion's drag session cleanly. */}
          <motion.img
            src={state.src}
            alt={state.alt || ''}
            drag="y"
            dragElastic={0.3}
            dragConstraints={{ top: 0, bottom: 0 }}
            onDragEnd={onDragEnd}
            onTap={(e: PointerEvent) => { e.stopPropagation(); setState(null) }}
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: '100%', maxHeight: '90vh',
              objectFit: 'contain', borderRadius: 12,
              boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
              cursor: 'zoom-out',
              y,
              touchAction: 'pan-y pinch-zoom',
            }}
            draggable={false}
          />

          {state.alt && (
            <div style={{
              position: 'absolute', bottom: 24, left: 0, right: 0,
              textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.5)',
              fontFamily: 'var(--mono)', letterSpacing: '0.06em',
              pointerEvents: 'none',
            }}>
              {state.alt}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
