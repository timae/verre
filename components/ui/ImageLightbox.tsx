'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TransformWrapper, TransformComponent, useTransformEffect, type ReactZoomPanPinchRef, type ReactZoomPanPinchContentRef, type ReactZoomPanPinchContextState } from 'react-zoom-pan-pinch'

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
    // Read live scale from the lib state (not React state) — guards against
    // a closure-staleness race when pinch-out finishes immediately before
    // pan-end.
    if (ref.state.scale > 1) return
    if (!start) return
    const dy = ref.state.positionY - start.y
    if (dy > DISMISS_DISTANCE) {
      setState(null)
      return
    }
    // Snap back at scale=1: stray horizontal or sub-threshold vertical pans
    // shouldn't leave the image translated.
    transformRef.current?.resetTransform(180)
  }

  // Suppress click-to-close briefly after any transform change so the
  // synthetic click that fires alongside the lib's double-tap zoom-out
  // doesn't dismiss the lightbox.
  const lastTransformRef = useRef(0)
  function close() { setState(null) }

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          onClick={e => { if (e.target === e.currentTarget) setState(null) }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
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
            onTransform={() => { lastTransformRef.current = Date.now() }}
            wheel={{ step: 0.2 }}
          >
            <LightboxContent
              src={state.src}
              alt={state.alt}
              close={close}
              lastTransformRef={lastTransformRef}
            />
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

// Inner content — must live inside TransformWrapper to use the hook. Holds
// the live `scale` in React state via useTransformEffect so both the cursor
// AND the click-to-close gate update on every transform tick.
function LightboxContent({
  src, alt, close, lastTransformRef,
}: {
  src: string; alt?: string
  close: () => void
  lastTransformRef: React.MutableRefObject<number>
}) {
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  // Stable callback so useTransformEffect doesn't re-subscribe on every
  // render — high-frequency churn during pinch gestures otherwise.
  const onTransform = useCallback((s: ReactZoomPanPinchContextState) => {
    scaleRef.current = s.state.scale
    setScale(s.state.scale)
  }, [])
  useTransformEffect(onTransform)

  function onImageClick(e: React.MouseEvent) {
    e.stopPropagation()
    // Read from ref, not state — avoids any closure-staleness hazard.
    if (scaleRef.current > 1) return
    if (Date.now() - lastTransformRef.current < 350) return
    close()
  }

  const cursor = scale > 1 ? 'zoom-out' : 'zoom-in'
  return (
    <TransformComponent
      wrapperStyle={{ width: '100%', height: '100%', cursor }}
      contentStyle={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}
    >
      {/* onClick on a wrapper div catches taps that fall on padding /
          background between the img bounds and the content div, which can
          happen on mobile due to objectFit and library-applied transforms. */}
      <div onClick={onImageClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <img
          src={src}
          alt={alt || ''}
          draggable={false}
          style={{
            maxWidth: '100%', maxHeight: '90vh',
            objectFit: 'contain', borderRadius: 12,
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
            cursor,
            userSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
        />
      </div>
    </TransformComponent>
  )
}
