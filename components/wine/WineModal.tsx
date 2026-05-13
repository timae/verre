'use client'
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, useMotionValue, animate } from 'framer-motion'
import { Modal, getModalStackDepth } from '@/components/ui/Modal'
import { UnsavedChangesConfirm } from '@/components/ui/UnsavedChangesConfirm'
import { WineInfoPane } from '@/components/wine/WineInfoPane'
import { RatingPane, type RatingValue } from '@/components/wine/RatingPane'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useSession } from '@/components/session/SessionShell'
import { sessionFetch } from '@/lib/sessionFetch'
import { useDirtyGuard } from '@/lib/dirtyGuard'
import { usePullToSwap } from '@/lib/usePullToSwap'
import { useQueryClient } from '@tanstack/react-query'
import { ProfilePreviewInline } from '@/components/profile/ProfilePreviewInline'
import type { ProvenanceRenderMode } from '@/components/wine/WineInfoPane'
import {
  CloseIcon, HeartIcon, MoreIcon,
  PencilIcon, TrashIcon, ArrowLeftIcon, ArrowRightIcon,
  StarIcon, CheckIcon, ResetIcon,
} from '@/components/ui/icons'

type Pane = 'info' | 'rate'

interface Props {
  wineId: string
  initialPane?: Pane
  onClose: () => void
}

// Two-pane wine modal: info on one tab, rating on the other. v4
// editorial chrome — header (3-dot menu + name + vintage + Save heart
// + close), underline-indicator tab strip, footer action bar (Rate
// CTA on info tab; Reset/Cancel/Commit on rate tab).
//
// Reads `wine` + `existing` rating from session context every render
// so live polling updates flow through — a host revealing a blind
// wine causes the open modal's info tab to populate without reload.
export function WineModal({ wineId, initialPane = 'info', onClose }: Props) {
  const { wines, myRatings, code, refresh, isHost, isProvider, isBlind, bookmarkedIds, isLoggedIn, sessionMeta, myId } = useSession()
  const qc = useQueryClient()

  // Prop is the entry point; once mounted the modal owns its navigation state.
  const [activeWineId, setActiveWineId] = useState(wineId)
  const wine = wines.find(w => w.id === activeWineId)
  const existing = myRatings[activeWineId]
  const currentIndex = wines.findIndex(w => w.id === activeWineId)
  const isFirstWine = currentIndex === 0
  const isLastWine = currentIndex === wines.length - 1

  const [pane, setPane] = useState<Pane>(initialPane)
  const [saving, setSaving] = useState(false)
  const [bookmarked, setBookmarked] = useState(() => bookmarkedIds?.has(activeWineId) || false)
  const [showEdit, setShowEdit] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rating, setRating] = useState<RatingValue>({
    score: existing?.score || 0,
    flavors: (existing?.flavors as Record<string, number>) || {},
    notes: existing?.notes || '',
  })
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  // Stashed `proceed` callback from the dirty guard. Null when the
  // confirm was opened by the modal's own close path (Discard just
  // calls onClose); non-null when an external nav triggered it
  // (Discard must also fire the original navigation).
  const pendingNavRef = useRef<(() => void) | null>(null)
  // Single-flight guard for commitAndSwap. The `saving` state flips
  // asynchronously through React; under arrow-key autorepeat or fast
  // double-clicks, multiple commitAndSwap calls can enter before
  // React commits saving=true and the buttons disable themselves.
  // The ref flips synchronously and gates entry to commitAndSwap.
  const commitInFlightRef = useRef(false)
  // `kind` drives the copy variant of the go-back bubble (rating / note / both).
  const [lastSwap, setLastSwap] = useState<{
    fromWineId: string
    kind: 'rating-and-note' | 'rating' | 'note'
    name: string
  } | null>(null)
  // Slide animation snapshot. Direction determines track order + start offset:
  //   'up'   → [OLD, NEW], y: 0 → -wrapperH. Matches pull-up gesture.
  //   'down' → [NEW, OLD], y: -wrapperH → 0. Matches pull-down gesture.
  // `fromPullDistance` picks up from the rubber-band position for continuous motion.
  const [outgoing, setOutgoing] = useState<{
    wineId: string
    pane: Pane
    direction: 'up' | 'down'
    rating: RatingValue
    fromPullDistance: number
    // Slide axis. 'y' on mobile (≤639px viewport) — the original
    // vertical conveyor that matches the touch pull gesture. 'x' on
    // desktop — horizontal page-turn that matches arrow-key / footer-
    // button navigation. Captured at slide start; doesn't change
    // mid-animation if the user resizes the browser.
    axis: 'x' | 'y'
  } | null>(null)
  // Drives both rubber-band pull and slide animation. Bound to BOTH x and y
  // simultaneously (inactive axis pinned to 0) to avoid a one-frame residual
  // transform when the active axis changes at onComplete.
  const slideOffset = useMotionValue(0)
  // Measured at slide start; positions the entering pane one viewport-size away.
  const slideSizeRef = useRef<number>(0)
  // Lets a rapid second swap stop the prior animation. Framer does NOT preempt
  // concurrent animations — both keep ticking, and the late finisher's
  // onComplete would nuke a fresh slide via slideOffset.set(0)+setOutgoing(null).
  const slideAnimRef = useRef<ReturnType<typeof animate<number>> | null>(null)
  // Stop any in-flight slide on unmount — onComplete would otherwise fire
  // on an unmounted component (React 18 no-ops the setters, but it's a leak).
  useEffect(() => () => {
    if (slideAnimRef.current) {
      slideAnimRef.current.stop()
      slideAnimRef.current = null
    }
  }, [])
  // Declared here (not near JSX) so the activeWineId-change effect can
  // reset scrollTop on swap — otherwise the new wine inherits the old scrollTop.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Tracks the last valid position of the active wine in the list so
  // that when a host deletes it mid-session we can still offer the
  // neighbouring wines as navigation targets. Updated on every render
  // while currentIndex is valid; frozen at the last known value once
  // the wine disappears (currentIndex === -1).
  const lastKnownIndexRef = useRef(currentIndex >= 0 ? currentIndex : 0)
  if (currentIndex >= 0) lastKnownIndexRef.current = currentIndex

  // Re-seed on wine change. Dep array is [activeWineId] only — deliberately
  // NOT myRatings, so a polling tick during an in-progress edit doesn't clobber
  // it. First run skipped via mountedRef (useState initializers already seeded).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    const next = myRatings[activeWineId]
    setRating({
      score: next?.score || 0,
      flavors: (next?.flavors as Record<string, number>) || {},
      notes: next?.notes || '',
    })
    setBookmarked(bookmarkedIds?.has(activeWineId) || false)
    setCommitError(null)
    setProvenanceOpen(false)
    setMenuOpen(false)
    // ⚠️ LOAD-BEARING — see docs/dev/ios-touch-gestures.md §6.
    // Reset scroll to the top of the new wine. Without this, the
    // scroll container's scrollTop is preserved across wine swaps —
    // which is usually invalid for the new content height (and on
    // iOS specifically, can leave the body rendered in empty space
    // because the post-swap scrollTop is past the new scrollHeight).
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWineId])

  // Preload neighbours so the swap renders without a visible image fetch.
  useEffect(() => {
    const prev = currentIndex > 0 ? wines[currentIndex - 1] : null
    const next = currentIndex < wines.length - 1 ? wines[currentIndex + 1] : null
    for (const w of [prev, next]) {
      if (w?.imageUrl) {
        const img = new Image()
        img.src = w.imageUrl
      }
    }
  }, [currentIndex, wines])

  // `disabled: slideActive` is load-bearing on iOS Safari. Touch events fire
  // through `pointer-events: none`, so without the hook-level gate a second
  // swap could queue mid-slide and overwrite the onComplete reset.
  const slideActive = !!outgoing
  const { pullDistance, boundary } = usePullToSwap({
    containerRef: scrollRef,
    isFirst: isFirstWine,
    isLast: isLastWine,
    disabled: saving || slideActive,
    onSwapPrev: () => prevWineId && commitAndSwap(prevWineId),
    onSwapNext: () => nextWineId && commitAndSwap(nextWineId),
  })

  // ⚠️ ORDERING IS LOCKED: `if (outgoing) return` MUST come before
  // the pullDistance branches. The slide's onComplete sets slideOffset=0
  // then setOutgoing(null) in the same tick; this effect re-runs on
  // the next render with outgoing=null and pullDistance=0. Without
  // the early return, the pullDistance===0 branch would see slideOffset=0
  // already and no-op — fine. But if `pullDistance` happened to be
  // non-zero at that exact moment (impossible today because the pull
  // hook is gated by `disabled: slideActive`, but a future change to
  // either gate could break it), the effect would jump slideOffset to the
  // pull offset without animation, mid-frame. Keep the outgoing-gate
  // first as the canonical "slide owns slideOffset" invariant.
  useEffect(() => {
    if (outgoing) return
    if (pullDistance === 0 && slideOffset.get() !== 0) {
      // Spring back from a sub-threshold pull release.
      const controls = animate(slideOffset, 0, { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] })
      return () => controls.stop()
    }
    slideOffset.set(pullDistance)
  }, [pullDistance, outgoing, slideOffset])

  // Scrolls the preview into view on open; detects outside-clicks to dismiss.
  const broughtByRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!provenanceOpen) return
    broughtByRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    function onDoc(e: MouseEvent) {
      // Topmost-modal gate: if a stacked modal is open above WineModal
      // (e.g. UserProfileModal launched from the preview's "visit
      // profile" button, or AddWineModal for editing), the click target
      // is portaled outside broughtByRef and would otherwise read as
      // "outside" → close the preview → unmount the preview's React
      // subtree → unmount the stacked modal too. Same expectedDepth
      // formula as the arrow-key handler.
      const expectedDepth = 1 + (pendingClose ? 1 : 0)
      if (getModalStackDepth() > expectedDepth) return
      if (broughtByRef.current && !broughtByRef.current.contains(e.target as Node)) {
        setProvenanceOpen(false)
      }
    }
    // setTimeout so the click that just opened it doesn't immediately
    // close (mousedown+mouseup propagate before the listener attaches).
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [provenanceOpen, pendingClose])

  // NOTE: no early-return here even when `wine` is undefined — hooks below
  // (beforeunload, dirty-guard, lastSwap dismiss) MUST run every render.
  // Early return would cause "Rendered fewer hooks than expected" on the
  // next polling tick that drops this wine from the list.

  // Blind redaction — server-side strips identifying fields for
  // non-host viewers. Host/cohost/provider-on-own-wine bypass.
  const isRedacted = !!(isBlind && wine?._blind && !wine?.revealedAt)
  const canEditThisWine = isHost || (isProvider && !!wine?.isMine)
  const canReorderThisWine = isHost

  // Brought-by clickability + block-pair rendering. Mirrors the
  // participants-list matrix in SessionPanel. We only get a click
  // path for logged-in adders (server only surfaces addedByUserId for
  // u:<id>). Block lists are scoped to current session participants —
  // a kicked-out adder won't appear in either set, so block state
  // can't be reflected at this layer and the callout falls through to
  // 'clickable'. The /api/users/<id> route the inline preview hits is
  // still block-aware, so a viewer who's blocked the kicked adder
  // sees the stripped profile view on tap — block enforcement holds
  // server-side, just not pre-emptively in the brought-by render.
  const adderIdentity = wine?.addedByUserId != null ? `u:${wine.addedByUserId}` : null
  const blocksOut = new Set(sessionMeta?.viewerBlocksOut ?? [])
  const blocksIn = new Set(sessionMeta?.viewerBlocksIn ?? [])
  const adderIsMe = !!adderIdentity && adderIdentity === myId
  const provenanceMode = resolveProvenanceMode(adderIdentity, myId, blocksOut, blocksIn)
  // Only logged-in viewers can open a profile preview AT ALL — anon
  // session participants get plain rendering. The mode above stays
  // accurate either way; this just gates the click handler.
  const provenanceClickable = isLoggedIn && (provenanceMode === 'clickable' || provenanceMode === 'blocked-by-me')

  // The rate pane's edits are local-only until commit. A "dirty"
  // form means at least one field carries a value AND it differs
  // from `existing`. Used by the close-confirm guard below.
  //
  // Flavor comparison walks the UNION of keys treating missing as 0.
  // Legacy ratings (pre wine-type-keyed flavors) store a sparse object
  // — only the dimensions the user touched — while RatingPane always
  // seeds the dense FL keyset. A naïve length check would report dirty
  // every time the user reopens an old rating without touching anything.
  //
  // Notes are coerced via `|| ''` defensively; the Redis path always
  // writes a string, but null could slip through from a non-Redis source.
  const dirty = (() => {
    const hasContent =
      rating.score > 0
      || Object.values(rating.flavors).some(v => v > 0)
      || rating.notes.trim() !== ''
    if (!hasContent) return false   // empty form on leave — silent close
    if (!existing) return true       // user typed something, never committed
    const existingFlavors = (existing.flavors as Record<string, number>) || {}
    const flavorKeys = new Set([
      ...Object.keys(rating.flavors),
      ...Object.keys(existingFlavors),
    ])
    let flavorsEqual = true
    for (const k of flavorKeys) {
      if ((rating.flavors[k] || 0) !== (existingFlavors[k] || 0)) {
        flavorsEqual = false
        break
      }
    }
    return rating.score !== existing.score
      || (rating.notes || '') !== (existing.notes || '')
      || !flavorsEqual
  })()

  // Ignored while saving — a Discard tap on a reopened confirm could fire
  // onClose while the original POST still completes, committing despite Discard.
  function requestClose() {
    if (saving) return
    if (dirty) setPendingClose(true)
    else onClose()
  }

  // Best-effort: mobile Safari ignores beforeunload.
  useEffect(() => {
    if (!dirty) return
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault()
      // Required for the prompt to actually show in some browsers;
      // the empty string is the modern convention since browsers
      // ignore the custom message and use a generic one.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // App-level dirty guard for client-side nav (bottom-nav Links, Leave
  // button, header logo, session/user panel buttons). When a guarded
  // surface is tapped while `dirty` is true, the guard fires
  // `onAttempt` with a `proceed` callback. We stash it on a ref so the
  // inner confirm's Discard branch can fire it after onClose, then
  // open the confirm modal. Save now / Keep editing leave the ref
  // untouched, so the nav is silently abandoned in those branches.
  //
  // Re-register every render rather than once on mount: `dirty` is
  // recomputed inline each render, and `commitRating` / `onClose`
  // close over the latest state. A useRef-stable wrapper would let us
  // skip re-registration but adds a layer for no measurable benefit.
  const dirtyGuard = useDirtyGuard()
  useEffect(() => {
    if (!dirtyGuard) return
    const unregister = dirtyGuard.register({
      isDirty: () => dirty && !saving,
      onAttempt: (proceed) => {
        // First-attempt-wins. If the user is already resolving an
        // earlier nav prompt (pendingClose=true, pendingNavRef set),
        // silently drop the second attempt rather than swap targets
        // mid-prompt. They tap the first nav, see the confirm, then
        // tap a second nav — without this gate, B would replace A
        // and Discard would land them on B instead of A. With the
        // gate, B is dropped; the user resolves A's prompt explicitly
        // and can re-tap B afterward if they still want it.
        if (pendingClose) return
        pendingNavRef.current = proceed
        setPendingClose(true)
      },
    })
    return unregister
  })

  // Primitive used by commitRating (save+close) and commitAndSwap (save+navigate).
  // Does NOT touch activeWineId / onClose / refresh — those are the caller's concern.
  async function commitWineRating(targetWineId: string, value: RatingValue): Promise<boolean> {
    setSaving(true)
    setCommitError(null)
    try {
      const res = await sessionFetch(code, `/api/session/${code}/rate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wineId: targetWineId, ...value }),
      })
      if (!res.ok) {
        const msg = res.status === 429
          ? 'Rate-limited. Try again shortly.'
          : res.status === 403
          ? 'You don’t have permission to rate this wine.'
          : `Save failed (${res.status}). Try again.`
        setCommitError(msg)
        setSaving(false)
        return false
      }
      setSaving(false)
      return true
    } catch {
      setCommitError('Network error. Check your connection and try again.')
      setSaving(false)
      return false
    }
  }

  async function commitRating(): Promise<boolean> {
    const ok = await commitWineRating(activeWineId, rating)
    if (ok) {
      refresh()
      onClose()
    }
    return ok
  }

  // Skips the POST when navigating away from an untouched wine.
  function hasContent(value: RatingValue): boolean {
    return value.score > 0
      || Object.values(value.flavors).some(v => v > 0)
      || value.notes.trim() !== ''
  }

  // `dirty` gate avoids re-POSTing on browse-only swaps (existing rating
  // opened, nothing changed, user taps next).
  //
  // If `dirty` is true but the commit fails, the swap is ABORTED so
  // the user stays on the failing wine with `commitError` surfaced;
  // they can retry or Cancel out.
  //
  // On a successful committed swap, the Go-back bubble is populated
  // with the wine the user just left + a copy variant matching what
  // was saved (rating, note, or both). Bubble auto-dismisses after 5s
  // or on the next swap.
  async function commitAndSwap(targetWineId: string): Promise<void> {
    // Single-flight gate. Held from entry until the slide animation
    // completes (or aborts) — NOT just until the POST resolves. The
    // slide takes 300ms; the POST often resolves in <100ms; if we
    // released the gate when the POST returned, a footer-button or
    // arrow-key re-tap during the remaining ~200ms would re-enter
    // here, overwrite `outgoing` mid-animation, and call slideOffset.set
    // out of order — exactly the slideOffset-reset gotcha documented in
    // components/wine/CLAUDE.md.
    if (commitInFlightRef.current) return
    commitInFlightRef.current = true
    // Track whether the slide animation owns the in-flight release.
    // When the slide kicks off, we hand the gate-release responsibility
    // to onComplete. Otherwise the finally below clears it synchronously.
    let releaseInFinally = true
    try {
      const fromWineId = activeWineId
      const fromWine = wine
      const fromRating = rating
      const fromIdx = currentIndex
      const toIdx = wines.findIndex(w => w.id === targetWineId)
      // Snapshot pull-distance NOW, before any await. usePullToSwap's
      // touchend handler calls reset() right after firing onSwap*, so
      // by the time an async commit resolves, pullDistance is already
      // 0 — losing the continuous-handoff offset.
      const fromPull = pullDistance
      // Fire the slide BEFORE the network commit. In the dirty path,
      // awaiting the POST first would let usePullToSwap.reset() flush
      // pullDistance=0 to React before the slide takes ownership of
      // slideOffset, producing a visible spring-back to 0 followed by a
      // jump to the slide start position. Setting up `outgoing` and
      // calling slideOffset.set/animate synchronously here keeps the track
      // under our control across the commit await — no snap-back, no
      // visible glitch on slow networks. If the commit later FAILS we
      // abort the slide and surface the error inline.
      const reduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const willAnimate = !reduced && fromIdx >= 0 && toIdx >= 0
        && fromIdx !== toIdx && scrollRef.current != null
      if (willAnimate) {
        // Pick the slide axis from viewport width. Mobile (≤639px)
        // keeps the original vertical conveyor that matches the touch
        // pull gesture. Desktop (>639px) uses a horizontal page-turn
        // — pull is touch-only and won't fire there anyway, so the
        // axis is governed entirely by the navigation source (footer
        // buttons / arrow keys). 639px is the same breakpoint as the
        // .hide-narrow class in globals.css for consistency.
        // No `typeof window` guard needed: willAnimate already required
        // `scrollRef.current != null`, which is browser-only.
        const axis: 'x' | 'y' = window.matchMedia('(max-width: 639px)').matches ? 'y' : 'x'
        // Capture the track's size along the active axis at slide
        // start. Stays stable across the 300ms animation even if the
        // user resizes the browser (rare; recoverable on next slide).
        const S = axis === 'y' ? scrollRef.current!.clientHeight : scrollRef.current!.clientWidth
        slideSizeRef.current = S
        const direction = toIdx > fromIdx ? 'up' : 'down'
        // The pull-rubber-band offset only makes sense on a vertical
        // slide (pull is vertical-only by design). For horizontal
        // slides on desktop, pulling-then-arrow-keying is an edge
        // case; carrying the vertical pull offset into a horizontal
        // start position would translate the pane SIDEWAYS from
        // where the user just visually pulled it down. Zero it.
        const startOffset = axis === 'y'
          ? (direction === 'up' ? fromPull : -S + fromPull)
          : (direction === 'up' ? 0 : -S)
        setOutgoing({
          wineId: fromWineId,
          pane,
          rating: fromRating,
          direction,
          fromPullDistance: axis === 'y' ? fromPull : 0,
          axis,
        })
        // Track layout in the JSX (identical math for both axes,
        // just swap "track-y" for "track-x" and H for W):
        //   - direction='up' → [OLD pane, NEW pane]. OLD at 0..S,
        //     NEW at S..2S. Offset starts at fromPull (continuing
        //     pull motion) and animates to -S (OLD exits leading,
        //     NEW arrives from trailing).
        //   - direction='down' → [NEW pane, OLD pane]. NEW at 0..S,
        //     OLD at S..2S. Offset starts at -S+fromPull and
        //     animates to 0 (NEW arrives from leading, OLD exits
        //     trailing).
        // Both panes are framer flex children (column for 'y', row
        // for 'x'). They cannot drift apart.
        const endOffset = direction === 'up' ? -S : 0
        // Stop any prior in-flight slide before starting a new one.
        // Framer's animate() does NOT preempt concurrent animations
        // on the same motion value — both keep ticking and the late
        // finisher's onComplete (slideOffset.set(0)+setOutgoing(null)) can
        // nuke a fresh slide. (Defensive: with the in-flight gate
        // held through onComplete, this path should be unreachable.
        // Kept as a belt-and-braces invariant.)
        if (slideAnimRef.current) slideAnimRef.current.stop()
        slideOffset.set(startOffset)
        slideAnimRef.current = animate(slideOffset, endOffset, {
          duration: 0.3,
          ease: [0.25, 0.1, 0.25, 1],  // ease-out
          onComplete: () => {
            // ⚠️ Reset slideOffset BEFORE clearing outgoing. When `outgoing`
            // clears, the track collapses from 2 children (OLD pane +
            // scrollRef) back to 1 (scrollRef occupying full wrapper
            // via flex:1). The translate must be 0 at that moment, or
            // scrollRef sits off-screen (shifted by ±H) for one frame;
            // then the pull-sync effect detects pullDistance=0 + slideOffset≠0
            // and spring-animates back to 0 — visible as a "rubber-band
            // in from above" glitch right after settle.
            slideOffset.set(0)
            // Defensive scrollTop=0 in case the user managed to touch
            // scrollRef mid-slide and trigger a native iOS scroll. The
            // earlier reset (before setActiveWineId) wouldn't catch a
            // scroll initiated AFTER setActiveWineId fired.
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            setOutgoing(null)
            slideAnimRef.current = null
            commitInFlightRef.current = false
          },
        })
        releaseInFinally = false
      } else {
        // Reduced-motion or first/last edge: no slide. Make sure slideOffset
        // is at 0 in case a prior slide / pull left it non-zero (rare,
        // but defensive).
        slideOffset.set(0)
      }
      let didCommit = false
      if (dirty) {
        const ok = await commitWineRating(fromWineId, fromRating)
        if (!ok) {
          // Commit failed — abort the slide before it confuses the
          // user. Without this, the snapshot has already played and
          // the user sees a phantom "wine slides out then back to the
          // same wine" effect on top of the commitError.
          if (slideAnimRef.current) {
            slideAnimRef.current.stop()
            slideAnimRef.current = null
          }
          slideOffset.set(0)
          setOutgoing(null)
          // Hand the gate-release back to the finally block since the
          // animation onComplete won't fire.
          releaseInFinally = true
          return
        }
        refresh()
        didCommit = true
      }
      // Reset scroll BEFORE swapping activeWineId so the new wine
      // mounts at scrollTop=0 in the same frame the slide enters.
      // Otherwise the activeWineId effect resets scrollTop after the
      // new pane has rendered, which on iOS can cause a one-frame
      // paint at the wrong position followed by the slide.
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      setActiveWineId(targetWineId)
      if (didCommit && fromWine) {
        // Copy variant depends on what the user actually committed:
        // - score > 0 + non-empty notes → "Rating & note saved"
        // - score > 0 + no notes        → "Rating saved"
        // - score === 0 + non-empty notes → "Note saved"
        // The "note saved" case is intentional — we DO let the user
        // commit a note without a score. The dirty gate ensures we
        // only POST when something actually changed.
        const hasScore = fromRating.score > 0
        const hasNote = fromRating.notes.trim() !== ''
        const kind: 'rating-and-note' | 'rating' | 'note' =
          hasScore && hasNote ? 'rating-and-note'
          : hasScore         ? 'rating'
          :                    'note'
        setLastSwap({ fromWineId, kind, name: fromWine.name })
      } else {
        setLastSwap(null)
      }
    } finally {
      // Only release here if the slide didn't take ownership.
      if (releaseInFinally) commitInFlightRef.current = false
    }
  }

  // Auto-dismiss the Go-back bubble after 8s. Reset whenever
  // `lastSwap` changes (covers both "set to a fresh swap" and "user
  // cleared it via Go back"). 8s gives a glanceable window for a
  // distracted taster — short enough not to linger, long enough that
  // a mid-pour conversation doesn't time it out.
  useEffect(() => {
    if (!lastSwap) return
    const t = setTimeout(() => setLastSwap(null), 8000)
    return () => clearTimeout(t)
  }, [lastSwap])

  // Resolve neighbouring wine ids relative to the current position.
  // Returns null at the list bounds. Computed inline at render rather
  // than memoized — wines array is small, lookups are O(n) but n<30.
  const prevWineId: string | null = (wine && !isFirstWine) ? wines[currentIndex - 1].id : null
  const nextWineId: string | null = (wine && !isLastWine) ? wines[currentIndex + 1].id : null

  // Keyboard navigation on desktop. Arrow keys move between wines.
  // ← previous, → next. Wheel-driven swap was removed (see
  // usePullToSwap header), so this is how desktop users navigate
  // without the buttons.
  //
  // Ignored when:
  //   - Any modifier key is held (Cmd/Ctrl/Alt/Shift) — reserved for
  //     browser/system shortcuts.
  //   - `saving` is true — same single-flight guard as the buttons.
  //   - Another modal is on top of WineModal (SessionPanel or any
  //     future overlay). Gated via the modal stack depth from Modal.tsx.
  //   - The inner Save-confirm modal is open (pendingClose=true).
  //     Its own Escape handles that, not arrows.
  //   - A nested control already consumed the key (defaultPrevented).
  //   - Focus is on an INPUT, TEXTAREA, contentEditable element, or
  //     anything inside a [data-no-pull] subtree (score slider,
  //     flavor segments, notes textarea).
  //
  // Re-runs every render so the captured closure (commitAndSwap +
  // pendingClose + saving + prevWineId/nextWineId) is always fresh.
  // Add/remove listener overhead is negligible.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      // Gate on both `saving` AND `slideActive` so a rapid arrow-key
      // re-tap during the post-POST / pre-onComplete window (~200ms
      // when the slide is still playing) doesn't silently fall
      // through to commitAndSwap's commitInFlightRef check and get
      // swallowed via e.preventDefault. Matches the footer buttons'
      // disabled semantics.
      if (saving || slideActive) return
      // Topmost-modal gate. If something is open ON TOP of WineModal
      // — SessionPanel or any future overlay — the arrow keys belong
      // to that surface, not us. WineModal's own outer
      // modal is always on the stack while this component is
      // mounted; the inner Save-confirm pushes one more when
      // pendingClose is true. Anything beyond that means another
      // overlay is above us.
      const expectedDepth = 1 + (pendingClose ? 1 : 0)
      if (getModalStackDepth() > expectedDepth) return
      // pendingClose=true also blocks (we're inside the inner
      // confirm; its own Escape handles it, not arrow keys).
      if (pendingClose) return
      // If a nested handler already consumed the key (preventDefault),
      // don't double-act on it. Defensive against any focused control
      // with its own Arrow-key semantics.
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      // Match the same opt-out contract used for the pointer
      // gesture — controls in `[data-no-pull]` (score slider, flavor
      // segments, notes textarea) reserve Arrow keys for their own
      // semantics, even if they don't yet implement them.
      if (t?.closest('[data-no-pull]')) return
      if (e.key === 'ArrowLeft' && prevWineId) {
        e.preventDefault()
        commitAndSwap(prevWineId)
      } else if (e.key === 'ArrowRight' && nextWineId) {
        e.preventDefault()
        commitAndSwap(nextWineId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Mirror commitRating's error handling — without it, a 429/500 on
  // delete silently closes the modal and pretends the deletion happened.
  // The user's saved rating still exists but the UI doesn't show it.
  async function resetRating() {
    // No server-side rating yet — just clear the local form.
    if (!existing) {
      setRating({ score: 0, flavors: {}, notes: '' })
      return
    }
    setSaving(true)
    setCommitError(null)
    try {
      const res = await sessionFetch(code, `/api/session/${code}/rate/${activeWineId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const msg = res.status === 429
          ? 'Rate-limited. Try again shortly.'
          : `Reset failed (${res.status}). Try again.`
        setCommitError(msg)
        setSaving(false)
        return
      }
      setSaving(false)
      refresh()
      setRating({ score: 0, flavors: {}, notes: '' })
    } catch {
      setCommitError('Network error. Check your connection and try again.')
      setSaving(false)
    }
  }

  async function toggleBookmark() {
    const method = bookmarked ? 'DELETE' : 'POST'
    // Snapshot the target wine at click time. If the user swaps to a
    // different wine before this fetch returns, we mustn't apply the
    // failure-revert to the new wine's state — the re-seed effect
    // already set the correct value for the new activeWineId.
    const targetWineId = activeWineId
    const wasBookmarked = bookmarked
    // Optimistic flip — revert on server failure so the heart doesn't
    // lie. On success, invalidate the in-session bookmarkedIds query
    // AND the /me/saved page's query so the bookmark surfaces there
    // immediately on next navigation.
    setBookmarked(!wasBookmarked)
    const res = await sessionFetch(code, `/api/session/${code}/wines/${targetWineId}/bookmark`, {
      method, headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      // Only revert if the user is still looking at the same wine.
      // If they swapped, the new wine's bookmarked state was seeded
      // by the activeWineId-change effect — overwriting it here
      // would be wrong.
      if (activeWineId === targetWineId) setBookmarked(wasBookmarked)
      return
    }
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
    qc.invalidateQueries({ queryKey: ['me-bookmarks'] })
  }

  async function moveWine(delta: number) {
    const idx = wines.findIndex(w => w.id === activeWineId)
    if (idx === -1) return
    // Bounds clamp: bail when the target index would fall outside the
    // list. Without this, splice(-1, ...) at idx=0 wraps to the
    // second-to-last slot (a noisy reorder, not a no-op).
    const target = idx + delta
    if (target < 0 || target >= wines.length) return
    const ordered = [...wines]
    const [w] = ordered.splice(idx, 1)
    ordered.splice(target, 0, w)
    await sessionFetch(code, `/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id) }),
    })
    refresh()
  }

  async function deleteWine() {
    await sessionFetch(code, `/api/session/${code}/wines/${activeWineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh(); onClose()
  }

  // Pull-progress and threshold-crossing flags for the boundary
  // indicator UI. `pulling` = user is actively dragging at a boundary;
  // `pullPast` = past the fire threshold (visual prompts shift from
  // "Pull to load" → "Release to load"). Touch is the only path
  // wired up — wheel events scroll content natively without firing
  // swaps. The 80px threshold matches the hook's fire threshold.
  const PULL_THRESHOLD = 80
  const pulling = boundary !== null && Math.abs(pullDistance) > 0
  const pullPast = Math.abs(pullDistance) >= PULL_THRESHOLD
  // Block message: at first/last wine boundaries, the indicator copy
  // shifts to "Start of the list" / "End of the cellar" with no fire.
  const blockedTop = boundary === 'top' && isFirstWine
  const blockedBottom = boundary === 'bottom' && isLastWine
  const blocked = blockedTop || blockedBottom

  // Wine missing — the host deleted it from another tab and the polling
  // tick delivered an updated wines array that no longer includes this
  // wine. This early return runs AFTER all hooks above so React's hook
  // sequence stays stable. We show a friendly message inside the same
  // full-size modal shell and offer navigation to neighbouring wines.
  if (!wine) {
    const lastIdx = lastKnownIndexRef.current
    // After deletion the wine at `lastIdx` is what was immediately
    // after the deleted one; `lastIdx - 1` is what was before it.
    const prevOnDelete = lastIdx > 0 ? wines[lastIdx - 1] : null
    const nextOnDelete = lastIdx < wines.length ? wines[lastIdx] : null
    const hasNeighbour = prevOnDelete || nextOnDelete
    return (
      <Modal onClose={onClose} maxWidth={620} maxHeight="90svh" minHeight="90svh">
        <div style={{display:'flex',flexDirection:'column',flex:1,minHeight:0}}>
          {/* Close X — top right, matches normal modal header */}
          <div style={{display:'flex',justifyContent:'flex-end',flexShrink:0}}>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background:'transparent',border:'none',
                width:32,height:32,borderRadius:8,
                color:'var(--fg-dim)',cursor:'pointer',
                display:'inline-flex',alignItems:'center',justifyContent:'center',
              }}
            ><CloseIcon size={18} /></button>
          </div>
          {/* Centred message + buttons inline */}
          <div style={{
            flex:1,display:'flex',flexDirection:'column',
            alignItems:'center',justifyContent:'center',
            gap:16,padding:'24px 32px 40px',textAlign:'center',
          }}>
            <div style={{fontSize:48}}>🍷</div>
            <div style={{fontSize:18,fontWeight:700,color:'var(--fg-warm)'}}>
              Oh no! This wine was just deleted.
            </div>
            <div style={{fontSize:13,color:'var(--fg-dim)',maxWidth:320}}>
              {hasNeighbour
                ? 'Head to another wine or close the tasting.'
                : 'No other wines in the lineup right now.'}
            </div>
            <div style={{display:'flex',gap:8,width:'100%',maxWidth:380,marginTop:4}}>
              {prevOnDelete && (
                <button
                  onClick={() => setActiveWineId(prevOnDelete.id)}
                  style={{
                    flex:1,display:'inline-flex',alignItems:'center',
                    justifyContent:'center',gap:6,
                    background:'var(--accent)',color:'var(--bg)',
                    border:'none',padding:'12px 14px',borderRadius:8,
                    fontSize:11,letterSpacing:'0.08em',
                    textTransform:'uppercase',fontWeight:600,cursor:'pointer',
                  }}
                >
                  <ArrowLeftIcon size={13} /> Previous wine
                </button>
              )}
              {nextOnDelete && (
                <button
                  onClick={() => setActiveWineId(nextOnDelete.id)}
                  style={{
                    flex:1,display:'inline-flex',alignItems:'center',
                    justifyContent:'center',gap:6,
                    background:'var(--accent)',color:'var(--bg)',
                    border:'none',padding:'12px 14px',borderRadius:8,
                    fontSize:11,letterSpacing:'0.08em',
                    textTransform:'uppercase',fontWeight:600,cursor:'pointer',
                  }}
                >
                  Next wine <ArrowRightIcon size={13} />
                </button>
              )}
              {!hasNeighbour && (
                <button
                  onClick={onClose}
                  style={{
                    flex:1,display:'inline-flex',alignItems:'center',
                    justifyContent:'center',
                    background:'var(--accent)',color:'var(--bg)',
                    border:'none',padding:'12px 14px',borderRadius:8,
                    fontSize:11,letterSpacing:'0.08em',
                    textTransform:'uppercase',fontWeight:600,cursor:'pointer',
                  }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    )
  }

  // Pane content renderer. Looks up everything from wineId so it can
  // render the OUTGOING snapshot during a slide animation as well as
  // the live wine. When `interactive` is false (outgoing snapshot),
  // RatingPane gets a no-op onChange and inputs don't reach setRating.
  // Provenance popover, broughtByRef, and the live ProfilePreview are
  // only wired into the live render — the snapshot is read-only.
  function renderPaneFor(
    forWineId: string,
    forPane: Pane,
    forRating: RatingValue,
    interactive: boolean,
  ) {
    const w = wines.find(x => x.id === forWineId)
    if (!w) return null
    const red = !!(isBlind && w._blind && !w.revealedAt)
    const adderId = w.addedByUserId != null ? `u:${w.addedByUserId}` : null
    const adderMe = !!adderId && adderId === myId
    const mode = resolveProvenanceMode(adderId, myId, blocksOut, blocksIn)
    const clickable = interactive && isLoggedIn && (mode === 'clickable' || mode === 'blocked-by-me')
    // Adder's profile picture for the brought-by badge. Resolved from
    // sessionMeta.participants, which the server already gates by block
    // (either direction) + profile-visibility tier — null arrives here
    // for anon adders, no-avatar users, and any case the gate denied.
    // We additionally clamp to mode==='clickable' as belt-and-braces: a
    // brief desync between viewerBlocksOut/In and a polled imageUrl
    // could otherwise flash a real face during a block flip.
    const adderImageUrl = (mode === 'clickable' && adderId
      ? sessionMeta?.participants.find(p => p.id === adderId)?.imageUrl ?? null
      : null)
    return (
      <>
        {forPane === 'info' && (
          red ? (
            <div style={{textAlign:'center',padding:'40px 16px'}}>
              <div style={{fontSize:48,marginBottom:12}}>🙈</div>
              <div style={{
                fontFamily:'var(--mono)',fontSize:14,fontWeight:700,
                color:'var(--fg-dim)',marginBottom:6,
              }}>{w.name}</div>
              <div style={{fontSize:11,color:'var(--fg-faint)',letterSpacing:'0.06em'}}>
                hidden until revealed
              </div>
            </div>
          ) : (
            <WineInfoPane
              wine={w}
              provenanceMode={mode}
              isSelf={adderMe}
              addedByImageUrl={adderImageUrl}
              onProvenanceClick={clickable
                ? () => setProvenanceOpen(o => !o)
                : undefined}
              broughtByRef={interactive ? broughtByRef : undefined}
              provenancePreview={interactive && provenanceOpen && w.addedByUserId != null && (
                <ProfilePreviewInline
                  userId={w.addedByUserId}
                  isSelf={adderMe}
                  viewerLoggedIn={isLoggedIn}
                  myId={myId.startsWith('u:') ? Number(myId.slice(2)) : null}
                />
              )}
            />
          )
        )}
        {forPane === 'rate' && (
          <RatingPane
            key={forWineId}
            wineType={red ? null : w.type}
            value={forRating}
            onChange={interactive ? setRating : () => {}}
          />
        )}
      </>
    )
  }

  return (
    // ⚠️ Heights in `svh`, NOT `vh`. `vh` changes as iOS Safari's
    // URL bar collapses during scroll, jumping the modal mid-gesture
    // and killing momentum. `svh` (small viewport height) is stable
    // across URL-bar collapse. See docs/dev/ios-touch-gestures.md §7.
    <Modal onClose={requestClose} maxWidth={1100} maxHeight="90svh" minHeight="90svh">
      {/* Outer column: header + tabs at top, scrollable body in middle,
          error banner / Go-back bubble / footer pinned at bottom. The
          fixed-height scroll-region is what the pull-to-swap hook
          watches; pulling past the top/bottom boundary triggers a wine
          swap (same effect as the prev/next buttons in the footer). */}
      <div style={{
        display:'flex',flexDirection:'column',
        // `flex:1; minHeight:0` consumes the sheet's available height
        // (the Modal sheet is now display:flex column itself when
        // min+maxHeight are both set — see Modal.tsx). Using flex:1
        // here instead of `height:100%` lets the sheet size to
        // content within its min/max range without forcing 90vh.
        flex:1,minHeight:0,position:'relative',
      }}>
      {/* HEADER — 3-dot menu (host-only) + wine name + vintage + Save + close */}
      <div style={{
        display:'flex',alignItems:'center',gap:8,
        flexShrink:0,
        marginBottom:14,paddingBottom:14,
        borderBottom:'1px solid var(--border)',
      }}>
        {canEditThisWine && (
          <OverflowMenu
            open={menuOpen}
            setOpen={setMenuOpen}
            canReorder={canReorderThisWine}
            onEdit={() => { setMenuOpen(false); setShowEdit(true) }}
            onMoveEarlier={() => { setMenuOpen(false); moveWine(-1) }}
            onMoveLater={() => { setMenuOpen(false); moveWine(1) }}
            onDelete={deleteWine}
          />
        )}
        <div style={{flex:1,minWidth:0,display:'flex',alignItems:'baseline',gap:10}}>
          <span style={{
            fontSize:18,fontWeight:700,color:'var(--fg-warm)',
            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
            letterSpacing:'-0.005em',
          }}>{wine.name}</span>
          {wine.vintage && (
            <span style={{
              fontFamily:'var(--mono)',fontSize:14,color:'var(--fg-dim)',
              letterSpacing:'0.06em',flexShrink:0,
            }}>{wine.vintage}</span>
          )}
        </div>
        {isLoggedIn && (
          <button
            onClick={toggleBookmark}
            title={bookmarked ? 'remove from saved' : 'save wine'}
            className="btn-icon-narrow"
            style={{
              display:'inline-flex',alignItems:'center',gap:6,
              padding:'6px 12px',borderRadius:100,
              border:'1px solid',
              background: bookmarked ? 'rgba(200,150,60,0.12)' : 'transparent',
              borderColor: bookmarked ? 'rgba(200,150,60,0.4)' : 'var(--border2)',
              color: bookmarked ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize:10,fontWeight:600,letterSpacing:'0.1em',
              textTransform:'uppercase',cursor:'pointer',
              transition:'all .15s',flexShrink:0,
            }}
          >
            <HeartIcon size={13} filled={bookmarked} />
            <span className="hide-narrow">{bookmarked ? 'Saved' : 'Save'}</span>
          </button>
        )}
        <button
          onClick={requestClose}
          aria-label="Close"
          style={{
            background:'transparent',border:'none',
            width:32,height:32,borderRadius:8,
            color:'var(--fg-dim)',cursor:'pointer',
            display:'inline-flex',alignItems:'center',justifyContent:'center',
            flexShrink:0,
          }}
        ><CloseIcon size={18} /></button>
      </div>

      {/* TAB STRIP — underline-indicator. Rate tab carries a pip with
          the current score when one exists. Tabs are tap-only;
          vertical pull on the scroll container below navigates wines.
          During a slide swap, tab buttons are pointer-events-gated so
          a stray tap can't mutate `pane` mid-animation (which would
          re-render the LIVE pane mid-flight while the outgoing
          snapshot stays frozen on the old tab — visible glitch). */}
      <div style={{
        display:'flex',gap:4,borderBottom:'1px solid var(--border)',
        marginBottom:18,flexShrink:0,
        pointerEvents: slideActive ? 'none' : 'auto',
      }}>
        <TabButton active={pane === 'info'} onClick={() => setPane('info')}>
          Wine info
        </TabButton>
        <TabButton active={pane === 'rate'} onClick={() => setPane('rate')}>
          <span>Rate</span>
          {existing?.score ? (
            <span style={{
              fontFamily:'var(--mono)',fontSize:10,
              padding:'2px 6px',borderRadius:3,
              border:'1px solid rgba(200,150,60,0.3)',
              background:'rgba(200,150,60,0.1)',
              color:'var(--accent)',letterSpacing:'0.04em',
            }}>{existing.score.toFixed(2)}</span>
          ) : null}
        </TabButton>
      </div>

      {/* Pullable region — clipping wrapper for the slide track + a
          host for the pull indicator overlay (the indicator is a
          sibling of the motion.div below so the rubber-band doesn't
          drag it off-screen). overflow:hidden is permanent so the
          off-screen pane during slide stays clipped without any
          toggling (toggling overflow on iOS Safari invalidates the
          stacking context and forces layer-tree rebuilds). */}
      <div style={{
        flex:1,minHeight:0,position:'relative',
        display:'flex',flexDirection:'column',
        overflow:'hidden',
      }}>
      {/* SLIDE TRACK (framer-motion conveyor):
          A flex container holding the OLD snapshot (during a slide)
          and the LIVE scrollRef. slideOffset drives the container's
          translate along the active axis. Because both panes are
          children of ONE translating parent, they cannot drift apart
          and overlap is geometrically impossible (the invariant is
          enforced by CSS layout, not by per-pane transform math).

          AXIS: 'y' on mobile (≤639px), 'x' on desktop.
            - 'y': flexDirection:'column', panes stacked vertically,
                   each pane height: H (clientHeight). Slide animates y.
            - 'x': flexDirection:'row', panes side-by-side, each pane
                   width: W (clientWidth). Slide animates x.
            Math is identical between axes — just swap H↔W and y↔x.

          BINDING (load-bearing): the motion.div binds slideOffset to
          BOTH x AND y simultaneously, with the inactive axis pinned
          to literal 0. Avoids a one-frame race when the active axis
          would otherwise change between renders (axis is captured
          per-slide; default outside slide is 'y').

          Direction 'up' (next wine, NEW from trailing edge):
            Children: [OLD pane, scrollRef]
            offset: fromPull → -S. OLD exits leading, scrollRef arrives.

          Direction 'down' (prev wine, NEW from leading edge):
            Children: [scrollRef, OLD pane]
            offset: -S + fromPull → 0. scrollRef arrives, OLD exits.

          Outside slide: only scrollRef is in the container (single
          flex:1 child filling the wrapper). slideOffset=0; the pull-
          rubber-band drives slideOffset via the sync effect above.
          scrollRef itself retains its native overflow-y:auto. The
          flex direction outside slide defaults to 'column' so the
          pull rubber-band continues to translate vertically. */}
      <motion.div
        style={{
          flex:1,minHeight:0,
          display:'flex',
          // Pin flex-direction to outgoing.axis (not a viewport check
          // that could re-fire on resize). Defaults to 'column' so
          // the pull rubber-band continues to work vertically when
          // there's no slide in flight.
          flexDirection: outgoing?.axis === 'x' ? 'row' : 'column',
          // Bind motion value to BOTH axes simultaneously. The
          // active axis (per outgoing.axis) carries slideOffset; the
          // inactive axis is a literal 0. Without this dual binding,
          // swapping which axis prop is set between renders leaves
          // residual transform from the previous axis until framer's
          // next tick — visible as a one-frame jitter on slow devices.
          x: outgoing?.axis === 'x' ? slideOffset : 0,
          y: outgoing?.axis === 'x' ? 0 : slideOffset,
        }}
      >
        {/* OLD pane goes BEFORE scrollRef for direction='up' (NEW
            arrives from the trailing edge), AFTER scrollRef for
            direction='down' (NEW arrives from the leading edge). The
            conditional rendering below achieves the DOM order swap.
            Outside a slide, neither block renders and scrollRef
            alone fills the wrapper. Pane sizing axis-aware: width
            for 'x', height for 'y'. */}
        {outgoing && outgoing.direction === 'up' && (
          <div
            aria-hidden
            style={{
              ...(outgoing.axis === 'x'
                ? { width: slideSizeRef.current }
                : { height: slideSizeRef.current }),
              flexShrink: 0,
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {renderPaneFor(outgoing.wineId, outgoing.pane, outgoing.rating, false)}
          </div>
        )}
        <div
          ref={scrollRef}
          style={{
            // During slide: scrollRef is one cell of the track,
            // explicit size S along the active axis so the conveyor
            // math (offset=±S) works. Outside slide: flex:1 fills
            // the wrapper for native scroll of tall content.
            ...(outgoing
              ? (outgoing.axis === 'x'
                  ? { width: slideSizeRef.current, flexShrink: 0 }
                  : { height: slideSizeRef.current, flexShrink: 0 })
              : { flex:1, minHeight:0 }),
            // ⚠️ LOAD-BEARING — DO NOT CHANGE without reading
            // docs/dev/ios-touch-gestures.md and components/wine/CLAUDE.md.
            // overflowY:auto + overscrollBehavior:contain + touchAction:pan-y
            // are required together for iOS Safari pull-to-swap to work
            // alongside native scroll + momentum. usePullToSwap.ts has
            // a dev-mode check that yells if any go missing.
            overflowY:'auto',
            overscrollBehavior:'contain',
            touchAction:'pan-y',
            position:'relative',
            // During slide, pointer events disabled so user can't tap
            // the incoming pane until it's settled.
            pointerEvents: outgoing ? 'none' as const : 'auto' as const,
          }}
        >
        {renderPaneFor(activeWineId, pane, rating, true)}
        </div>
        {outgoing && outgoing.direction === 'down' && (
          <div
            aria-hidden
            style={{
              ...(outgoing.axis === 'x'
                ? { width: slideSizeRef.current }
                : { height: slideSizeRef.current }),
              flexShrink: 0,
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {renderPaneFor(outgoing.wineId, outgoing.pane, outgoing.rating, false)}
          </div>
        )}
      </motion.div>

      {/* Pull indicator — overlays the pullable region's edges with
          contextual copy as the user pulls past a boundary. Sibling
          of the slide track (motion.div above), so the rubber-band
          translation doesn't drag it off-screen. Anchored to the
          pullable-region wrapper which has the same bounds as the
          track.
          - Top + first wine     → "↑ Start of the list" (capped pull)
          - Top + not first      → "↑ Pull to load previous" / "Release to load previous"
          - Bottom + last wine   → "↓ Sorry to disappoint. That's the last one"
          - Bottom + not last    → "↓ Pull to load next" / "Release to load next"
          Opacity tracks pull progress so the indicator fades in as
          the user drags. */}
      {pulling && boundary && (
        <div style={{
          position:'absolute',left:0,right:0,
          // Pin the chip at the EDGE of the pulled content, not at
          // the wrapper edge. The body translates by pullDistance,
          // exposing a void between the wrapper edge and the content
          // edge. Placing the chip at that boundary keeps it just
          // outside the wine pane (in the pull void) instead of
          // overlapping whatever is at the top/bottom of the content
          // (e.g. the wine image on Bijou).
          ...(boundary === 'top'
            ? { top: Math.max(0, pullDistance - 40), paddingTop: 6 }
            : { bottom: Math.max(0, -pullDistance - 40), paddingBottom: 6 }),
          display:'flex',justifyContent:'center',alignItems:'center',
          pointerEvents:'none',zIndex:5,
          // Baseline opacity so the indicator is visible the instant
          // the gesture starts; ramps to fully opaque well before the
          // threshold so the user sees the cue early. Without the
          // floor, the first ~5px of drag would render a 0-opacity
          // chip and the user might think nothing's happening.
          opacity: 0.35 + Math.min(0.65, Math.abs(pullDistance) / 60),
        }}>
          <div style={{
            fontSize:10,fontFamily:'var(--mono)',
            letterSpacing:'0.1em',textTransform:'uppercase',
            color: pullPast && !blocked
              ? 'var(--accent)'
              : 'var(--fg-warm-soft)',
            padding:'6px 12px',borderRadius:100,
            background:'var(--bg2)',
            border:`1px solid ${pullPast && !blocked ? 'rgba(200,150,60,0.4)' : 'var(--border)'}`,
            whiteSpace:'nowrap',
          }}>
            {/* Arrow points at the wine being summoned, not at the
                finger's drag direction. Native iOS pull-to-refresh
                convention: at top the previous wine is "above" so the
                arrow points UP; at bottom the next wine is "below" so
                the arrow points DOWN. Blocked boundaries already
                point outward (start ↑ / end ↓) which is correct.
                Copy is written in proper sentence case; the chip's
                CSS `textTransform: 'uppercase'` handles display. */}
            {boundary === 'top' && blockedTop && '↑ Start of the list'}
            {boundary === 'top' && !blockedTop && (
              pullPast ? '↑ Release to load previous' : '↑ Pull to load previous'
            )}
            {boundary === 'bottom' && blockedBottom && '↓ Sorry to disappoint. That\'s the last one'}
            {boundary === 'bottom' && !blockedBottom && (
              pullPast ? '↓ Release to load next' : '↓ Pull to load next'
            )}
          </div>
        </div>
      )}
      </div>

      {/* Inline commit-error banner on the rate tab. Surfaces 429/403/
          500/network failures from the most recent commit attempt so
          the user sees something happened. Cleared automatically on
          the next attempt. */}
      {pane === 'rate' && commitError && (
        <div style={{
          marginTop:14,padding:'10px 12px',
          borderRadius:8,
          border:'1px solid rgba(184,64,64,0.5)',
          background:'rgba(184,64,64,0.08)',
          color:'rgba(220,90,90,1)',fontSize:12,lineHeight:1.4,
        }}>{commitError}</div>
      )}

      {/* Go-back toast portaled to document.body — floats at top of
          viewport over the modal backdrop, iOS-style. Surfaces after
          a successful auto-commit + swap so the user can return to
          the wine they just left if the navigation was accidental.
          Auto-dismisses after 5s. Whole toast is clickable (more tap
          area on mobile). "Go back" fires commitAndSwap so any in-
          progress edits on the new wine are saved too (or silent if
          empty). Copy variant matches what was actually committed.
          z-index 60 sits above the Modal (z-50). */}
      {lastSwap && typeof document !== 'undefined' && createPortal(
        <div
          role="status"
          onClick={() => {
            if (saving) return
            const target = lastSwap.fromWineId
            setLastSwap(null)
            commitAndSwap(target)
          }}
          style={{
            position:'fixed',
            top:'max(16px, env(safe-area-inset-top))',
            left:'50%',
            transform:'translateX(-50%)',
            zIndex:60,
            maxWidth:'min(420px, calc(100vw - 32px))',
            width:'max-content',
            padding:'10px 14px',
            display:'flex',alignItems:'center',gap:12,
            border:'1px solid rgba(200,150,60,0.4)',
            background:'var(--bg2)',
            backdropFilter:'blur(8px)',
            WebkitBackdropFilter:'blur(8px)',
            borderRadius:10,
            boxShadow:'0 8px 24px rgba(0,0,0,0.25)',
            fontSize:12,color:'var(--fg-warm-soft)',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          <span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {lastSwap.kind === 'rating-and-note' && 'Rating & note saved on '}
            {lastSwap.kind === 'rating'          && 'Rating saved on '}
            {lastSwap.kind === 'note'            && 'Note saved on '}
            <span style={{color:'var(--fg-warm)',fontWeight:600}}>{lastSwap.name}</span>
          </span>
          <span
            style={{
              display:'inline-flex',alignItems:'center',gap:4,
              color:'var(--accent)',
              border:'1px solid rgba(200,150,60,0.4)',
              padding:'6px 10px',borderRadius:6,
              fontSize:10,letterSpacing:'0.08em',
              textTransform:'uppercase',fontWeight:600,
              flexShrink:0,
            }}
          >
            <ArrowLeftIcon size={11} />
            <span>Go back</span>
          </span>
        </div>,
        document.body
      )}

      {/* FOOTER — action bar. Different per tab. Prev/next buttons
          appear when the user has neighbouring wines; the primary CTA
          adapts copy based on position (mid-list vs last wine).
          Labels drop "wine" to fit on narrow screens — full forms
          would wrap awkwardly with 4 buttons on the rate tab. */}
      <div style={{
        marginTop:18,paddingTop:14,
        borderTop:'1px solid var(--border)',
        display:'flex',gap:8,flexWrap:'wrap',
      }}>
        {pane === 'info' && (
          <>
            {prevWineId && (
              <button
                onClick={() => commitAndSwap(prevWineId)}
                disabled={saving}
                aria-label="Previous wine"
                aria-keyshortcuts="ArrowLeft"
                title="Previous wine (←)"
                style={{
                  display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,
                  background:'transparent',color:'var(--fg-dim)',
                  border:'1px solid var(--border)',padding:'12px 14px',
                  borderRadius:8,fontSize:11,letterSpacing:'0.08em',
                  textTransform:'uppercase',fontWeight:600,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  flexShrink:0,
                }}
              >
                <ArrowLeftIcon size={13} />
                <span>Prev</span>
              </button>
            )}
            <button
              onClick={() => setPane('rate')}
              style={{
                flex:1,
                display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,
                background:'var(--accent)',color:'var(--bg)',
                border:'none',padding:'12px 22px',borderRadius:8,
                fontWeight:700,fontSize:12,
                letterSpacing:'0.08em',textTransform:'uppercase',
                cursor:'pointer',
                boxShadow:'0 6px 24px -8px var(--accent)',
              }}
            >
              <StarIcon size={16} filled />
              Rate this wine
            </button>
            {nextWineId && (
              <button
                onClick={() => commitAndSwap(nextWineId)}
                disabled={saving}
                aria-label="Next wine"
                aria-keyshortcuts="ArrowRight"
                title="Next wine (→)"
                style={{
                  display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,
                  background:'transparent',color:'var(--fg-dim)',
                  border:'1px solid var(--border)',padding:'12px 14px',
                  borderRadius:8,fontSize:11,letterSpacing:'0.08em',
                  textTransform:'uppercase',fontWeight:600,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  flexShrink:0,
                }}
              >
                <span>Next</span>
                <ArrowRightIcon size={13} />
              </button>
            )}
          </>
        )}
        {pane === 'rate' && (
          <>
            {prevWineId && (
              <button
                onClick={() => commitAndSwap(prevWineId)}
                disabled={saving}
                aria-label="Save and go to previous wine"
                aria-keyshortcuts="ArrowLeft"
                title="Save & previous wine (←)"
                style={{
                  display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,
                  background:'transparent',color:'var(--accent)',
                  border:'1px solid rgba(200,150,60,0.4)',
                  padding:'12px 14px',borderRadius:8,
                  fontSize:11,letterSpacing:'0.08em',
                  textTransform:'uppercase',fontWeight:600,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  flexShrink:0,
                }}
              >
                <ArrowLeftIcon size={13} />
                <span>Save &amp; prev</span>
              </button>
            )}
            <button
              onClick={requestClose}
              style={{
                display:'inline-flex',alignItems:'center',justifyContent:'center',
                background:'transparent',color:'var(--fg-dim)',
                border:'1px solid var(--border)',padding:'12px 14px',
                borderRadius:8,fontSize:11,letterSpacing:'0.08em',
                textTransform:'uppercase',fontWeight:600,cursor:'pointer',
                flexShrink:0,
              }}
            >Cancel</button>
            {/* Delete sits between Cancel and the primary Save CTA so
                the destructive action is closest to the destructive
                corner of the footer, not adjacent to Save & prev (the
                two accent buttons would otherwise frame Delete on
                both sides). */}
            {(existing || hasContent(rating)) && (
              <ResetButton onReset={resetRating} />
            )}
            <button
              onClick={() => isLastWine
                ? commitRating()
                : commitAndSwap(nextWineId!)}
              disabled={saving}
              aria-keyshortcuts={isLastWine ? undefined : 'ArrowRight'}
              title={isLastWine ? undefined : 'Save & next wine (→)'}
              style={{
                flex:1,
                display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,
                background:'var(--accent)',color:'var(--bg)',
                border:'none',padding:'12px 22px',borderRadius:8,
                fontWeight:700,fontSize:12,
                letterSpacing:'0.08em',textTransform:'uppercase',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                boxShadow:'0 6px 24px -8px var(--accent)',
              }}
            >
              <CheckIcon size={16} stroke={2.2} />
              {saving
                ? 'Saving…'
                : isLastWine
                ? 'Save & close'
                : 'Save & next'}
              {!saving && !isLastWine && <ArrowRightIcon size={14} />}
            </button>
          </>
        )}
      </div>

      {showEdit && (
        <AddWineModal
          code={code} editWine={wine}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refresh() }}
        />
      )}

      {/* Uncommitted-rating confirm. `pendingNavRef` carries the
          proceed callback when the gate fired from an external nav
          (bottom-nav, Leave, header logo via DirtyGuard.attemptNav);
          null when fired from a local close path (X, backdrop, X-key).
          Resolutions: Discard → onClose + run pendingNav. Keep
          editing / dismiss → clear pendingNav. Save → commit; on
          success commitRating fires onClose internally so we just
          need to fire pendingNav. On failure the confirm stays open
          with commitError surfaced. */}
      <UnsavedChangesConfirm
        open={pendingClose}
        title="Save your rating?"
        subtitle="You have unsaved changes on this wine."
        error={commitError}
        saving={saving}
        onDismiss={() => {
          if (saving) return
          pendingNavRef.current = null
          setPendingClose(false)
        }}
        onKeep={() => {
          pendingNavRef.current = null
          setPendingClose(false)
        }}
        onDiscard={() => {
          const nav = pendingNavRef.current
          pendingNavRef.current = null
          setPendingClose(false)
          onClose()
          if (nav) nav()
        }}
        onSave={async () => {
          const ok = await commitRating()
          if (ok) {
            // commitRating already fired onClose internally — modal's
            // already unmounting. The pendingNav still needs to fire
            // so the user lands at the bottom-nav target. Read & clear
            // the ref before invoking to guard against a double-fire.
            const nav = pendingNavRef.current
            pendingNavRef.current = null
            setPendingClose(false)
            if (nav) nav()
          }
          return ok
        }}
      />
      </div>
    </Modal>
  )
}

// Brought-by block-pair matrix. Centralised here so the live pane and
// the outgoing animation snapshot use identical logic.
function resolveProvenanceMode(
  adderId: string | null,
  myId: string,
  blocksOut: Set<string>,
  blocksIn: Set<string>,
): ProvenanceRenderMode {
  if (!adderId) return 'plain'
  if (adderId === myId) return 'clickable'
  const blkOut = blocksOut.has(adderId)
  const blkIn = blocksIn.has(adderId)
  if (blkOut && blkIn) return 'anon-style'   // mutual block
  if (blkOut) return 'blocked-by-me'
  if (blkIn) return 'anon-style'
  return 'clickable'
}

// Tight icon-button for the rate-tab footer's destructive action.
// Two-press confirm (first tap arms with a red tint, second tap fires).
// Sits next to Cancel + Commit without stealing room from the primary CTA.
//
function ResetButton({ onReset }: { onReset: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={() => { if (armed) onReset(); else setArmed(true) }}
      style={{
        display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,
        background:'transparent',
        color: armed ? 'rgba(220,90,90,1)' : 'var(--fg-dim)',
        border: `1px solid ${armed ? 'rgba(184,64,64,0.7)' : 'var(--border)'}`,
        padding:'12px 14px',borderRadius:8,
        fontSize:11,letterSpacing:'0.08em',
        textTransform:'uppercase',fontWeight:600,cursor:'pointer',
        flexShrink:0,
        // Fixed width sized to the wider label ("Tap to delete") so
        // the button doesn't grow/shrink between idle and armed.
        width:148,
        transition:'border-color .15s, color .15s',
      }}
    >
      <ResetIcon size={13} />
      <span>{armed ? 'Tap to confirm' : 'Reset rating'}</span>
    </button>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        // minHeight locks the tab strip's vertical size regardless of
        // whether the Rate tab carries a score pip (which is slightly
        // taller than the bare label). Without this, switching between
        // wines where one has a rating and one doesn't would shift
        // every panel below the tab strip by 1-2px.
        position:'relative',background:'transparent',border:'none',
        padding:'12px 16px',minHeight:44,
        fontSize:11,letterSpacing:'0.12em',textTransform:'uppercase',
        fontWeight:700,
        color: active ? 'var(--fg)' : 'var(--fg-dim)',
        cursor:'pointer',display:'inline-flex',alignItems:'center',gap:8,
        whiteSpace:'nowrap',transition:'color .15s',
      }}
    >
      {children}
      {active && (
        <span style={{
          position:'absolute',bottom:-1,left:12,right:12,
          height:2,borderRadius:'2px 2px 0 0',
          background:'var(--accent)',
        }} />
      )}
    </button>
  )
}

// 3-dot overflow menu for wine-management actions. Closes on outside
// click and Escape. Host-only callers (or provider on their own wines)
// see it; others don't render the trigger.
function OverflowMenu({
  open, setOpen, canReorder,
  onEdit, onMoveEarlier, onMoveLater, onDelete,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  canReorder: boolean
  onEdit: () => void
  onMoveEarlier: () => void
  onMoveLater: () => void
  onDelete: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  return (
    <div ref={wrapRef} style={{position:'relative',flexShrink:0}}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="More actions"
        style={{
          background:'transparent',border:'none',
          width:32,height:32,borderRadius:8,
          color:'var(--fg-dim)',cursor:'pointer',
          display:'inline-flex',alignItems:'center',justifyContent:'center',
        }}
      ><MoreIcon size={18} /></button>
      {open && (
        <div style={{
          position:'absolute',top:'calc(100% + 6px)',left:0,
          minWidth:180,background:'var(--bg3)',
          border:'1px solid var(--border)',borderRadius:10,
          padding:6,boxShadow:'0 12px 32px -8px rgba(0,0,0,0.6)',
          zIndex:20,
        }}>
          <MenuItem icon={<PencilIcon size={14} />} onClick={onEdit}>Edit wine</MenuItem>
          {canReorder && <>
            <MenuItem icon={<ArrowLeftIcon size={14} />} onClick={onMoveEarlier}>Move earlier</MenuItem>
            <MenuItem icon={<ArrowRightIcon size={14} />} onClick={onMoveLater}>Move later</MenuItem>
          </>}
          <div style={{height:1,background:'var(--border)',margin:'4px 4px'}} />
          <DeleteMenuItem onConfirm={onDelete} />
        </div>
      )}
    </div>
  )
}

// Two-press delete row inside the overflow menu. First tap arms with
// the "tap to confirm" label tinted red; second tap within 3s fires.
// Keeps the menu open while armed so the user sees the state change.
function DeleteMenuItem({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={e => {
        // Don't bubble — the overflow menu's outside-click handler
        // would close us on the first tap otherwise.
        e.stopPropagation()
        if (armed) onConfirm()
        else setArmed(true)
      }}
      style={{
        display:'flex',alignItems:'center',gap:10,
        width:'100%',padding:'8px 10px',
        background: armed ? 'rgba(199,86,96,0.12)' : 'transparent',
        border:'none',cursor:'pointer',borderRadius:6,
        fontSize:13,textAlign:'left',
        color: '#c75660',
        fontWeight: armed ? 700 : 400,
        transition:'background .12s',
      }}
    >
      <span style={{display:'inline-flex',opacity:0.8}}>
        <TrashIcon size={14} />
      </span>
      <span>{armed ? 'Tap again to delete' : 'Delete'}</span>
    </button>
  )
}

function MenuItem({ icon, onClick, danger, children }: {
  icon: React.ReactNode
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display:'flex',alignItems:'center',gap:10,
        width:'100%',padding:'8px 10px',
        background:'transparent',border:'none',
        cursor:'pointer',borderRadius:6,
        fontSize:13,textAlign:'left',
        color: danger ? '#c75660' : 'var(--fg)',
        transition:'background .12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(199,86,96,0.1)' : 'var(--bg4)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{display:'inline-flex',opacity:0.8}}>{icon}</span>
      <span>{children}</span>
    </button>
  )
}
