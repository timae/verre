'use client'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'

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

export function ImageLightbox() {
  const [state, setState] = useState<{ src: string; alt?: string } | null>(null)
  // Drives the cursor + tap-to-close gating. State, not ref, so the cursor
  // re-renders when the user pinches in/out.
  const [zoomed, setZoomed] = useState(false)
  const panStartRef = useRef<{ x: number; y: number } | null>(null)
  const transformRef = useRef<ReactZoomPanPinchContentRef | null>(null)

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

  function onPanningStart(ref: ReactZoomPanPinchRef) {
    panStartRef.current = { x: ref.state.positionX, y: ref.state.positionY }
  }

  function onPanningStop(ref: ReactZoomPanPinchRef) {
    const start = panStartRef.current
    panStartRef.current = null
    // Read scale from the live lib state, not React state — avoids a
    // closure-staleness race when a pinch-out finishes immediately before
    // a pan ends (the rerender hasn't landed yet).
    if (ref.state.scale > 1) return
    if (!start) return
    const dy = ref.state.positionY - start.y
    if (dy > DISMISS_DISTANCE) {
      setState(null)
      return
    }
    // Snap back to centre — at scale=1 we don't want stray horizontal or
    // sub-threshold vertical pans to leave the image translated.
    transformRef.current?.resetTransform(180)
  }

  function onTransformed(_: ReactZoomPanPinchRef, st: { scale: number }) {
    setZoomed(st.scale > 1)
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
            padding: 16, cursor: zoomed ? 'zoom-out' : 'zoom-in',
          }}
        >
          <button
            onClick={() => setState(null)}
            style={{
              position: 'absolute', top: 16, right: 16, zIndex: 1,
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff', fontSize: 18, lineHeight: 1, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ✕
          </button>

          <TransformWrapper
            ref={transformRef}
            minScale={1}
            maxScale={5}
            limitToBounds={false}
            centerOnInit
            doubleClick={{ mode: 'toggle', step: 1.5 }}
            onPanningStart={onPanningStart}
            onPanningStop={onPanningStop}
            onTransform={onTransformed}
            wheel={{ step: 0.2 }}
          >
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '100%' }}
              contentStyle={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}
            >
              <img
                src={state.src}
                alt={state.alt || ''}
                onClick={e => { e.stopPropagation(); if (!zoomed) setState(null) }}
                draggable={false}
                style={{
                  maxWidth: '100%', maxHeight: '90vh',
                  objectFit: 'contain', borderRadius: 12,
                  boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
                  cursor: zoomed ? 'zoom-out' : 'zoom-in',
                  userSelect: 'none',
                  WebkitTouchCallout: 'none',
                }}
              />
            </TransformComponent>
          </TransformWrapper>

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
