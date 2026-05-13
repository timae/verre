'use client'
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, useMotionValue, animate } from 'framer-motion'
import { Modal, getModalStackDepth } from '@/components/ui/Modal'
import { WineInfoPane } from '@/components/wine/WineInfoPane'
import { RatingPane, type RatingValue } from '@/components/wine/RatingPane'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useSession } from '@/components/session/SessionShell'
import { sessionFetch } from '@/lib/sessionFetch'
import { useDirtyGuard } from '@/lib/dirtyGuard'
import { sessionPath } from '@/lib/sessionCode'
import { usePullToSwap } from '@/lib/usePullToSwap'
import { useRouter, usePathname } from 'next/navigation'
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
export function WineModal({ wineId, initialPane = 'rate', onClose }: Props) {
  const { wines, myRatings, code, refresh, isHost, isProvider, isBlind, bookmarkedIds, isLoggedIn, sessionMeta, myId } = useSession()
  const qc = useQueryClient()

  // `activeWineId` is the currently-rendered wine. Initialized from
  // the `wineId` prop, but mutated locally on prev/next navigation so
  // the user can move through wines without closing/reopening the
  // modal. The prop is only the entry point; once mounted the modal
  // owns its navigation state.
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
  // Provenance preview expanded/collapsed. The brought-by name in the
  // info pane toggles this; the preview mounts inline below the
  // callout. Mirrors SessionPanel's expanded-row pattern.
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  // Uncommitted-rating guard. When the user has typed/dragged/tapped
  // on the rate pane and tries to leave without committing, we show a
  // confirm modal. `pendingClose` holds the leave-action to fire after
  // resolution (Save now / Discard).
  const [pendingClose, setPendingClose] = useState(false)
  // Error surface for the commit POST. Cleared on retry. Surfaced in
  // both the outer footer (when the user committed via the Commit
  // button) and the inner confirm (when they committed via Save now).
  const [commitError, setCommitError] = useState<string | null>(null)
  // When the dirty guard fires from an external navigation attempt
  // (bottom-nav Link, Leave button, header logo, panel triggers), the
  // `proceed` callback the guard handed us is stashed here so the
  // Discard branch of the inner confirm can invoke it after running
  // the local `onClose`. Null when the prompt was opened by the user
  // tapping the modal's own close paths — Discard just calls onClose.
  const pendingNavRef = useRef<(() => void) | null>(null)
  // Single-flight guard for commitAndSwap. The `saving` state flips
  // asynchronously through React; under arrow-key autorepeat or fast
  // double-clicks, multiple commitAndSwap calls can enter before
  // React commits saving=true and the buttons disable themselves.
  // The ref flips synchronously and gates entry to commitAndSwap.
  const commitInFlightRef = useRef(false)
  // Go-back bubble state. Populated after a successful auto-commit +
  // swap; cleared on next swap or after the 5s timeout. The user can
  // tap "Go back" to return to the wine they just left. The `kind`
  // field drives the copy variant (rating / note / both).
  const [lastSwap, setLastSwap] = useState<{
    fromWineId: string
    kind: 'rating-and-note' | 'rating' | 'note'
    name: string
  } | null>(null)
  // Slide-on-swap state. When commitAndSwap fires, we snapshot the
  // outgoing wine (id + rating + pane + direction) and render it as
  // a flex sibling of the live scrollRef inside a vertical "track"
  // container. The track's `y` motion value is animated by framer-
  // motion from a starting offset (where OLD is visible) to an end
  // offset (where NEW is visible). The two panes are STACKED in flex
  // — they can never drift apart or overlap, because their relative
  // position is just CSS layout.
  //
  // Direction:
  //   - 'up'   = next wine selected. Track order [OLD, NEW]. y goes
  //              from 0 (OLD visible at top) to -wrapperH (OLD exits
  //              top, NEW visible). Matches pull-up gesture.
  //   - 'down' = previous wine selected. Track order [NEW, OLD]. y
  //              goes from -wrapperH (OLD visible at top) to 0 (NEW
  //              visible). Matches pull-down gesture.
  //
  // `fromPullDistance` carries the rubber-band offset at the moment
  // of swap so the slide picks up where the pull left off (continuous
  // motion). It's added to the framer y-target so animate starts from
  // the right position. Pull-distance is signed: positive at top,
  // negative at bottom.
  const [outgoing, setOutgoing] = useState<{
    wineId: string
    pane: Pane
    rating: RatingValue
    direction: 'up' | 'down'
    fromPullDistance: number
  } | null>(null)
  // Framer y motion value for the slide track. Owned by useMotionValue
  // so changes don't trigger React re-renders; framer drives the
  // underlying DOM transform directly. Used for BOTH:
  //   1. The pull rubber-band (track shifts by pullDistance during a
  //      pull gesture; springs back to 0 on release below threshold).
  //   2. The slide animation when commitAndSwap fires past threshold.
  const slideY = useMotionValue(0)
  // Measured height of the scroll container at the moment a slide
  // fires. Used to position the entering pane in the track (it sits
  // one wrapperH below or above the live pane).
  const slideHeightRef = useRef<number>(0)
  // Ref on the scroll container — declared here (vs. closer to its
  // JSX usage) so the activeWineId-change effect below can reset
  // scrollTop on swap. Without that reset, the new wine renders
  // with the previous wine's scrollTop, which is usually invalid
  // for the new content height and shows mostly empty space.
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Re-seed per-wine state when the user navigates to a different
  // wine in the same modal. The state initializers on `useState` only
  // run once at mount; without this effect, the rating/bookmarked/
  // commitError values would persist across wine changes.
  //
  // Dep array is `[activeWineId]` only — the effect re-reads
  // `myRatings` at the moment of the swap and seeds from whatever the
  // polled data shows then. We deliberately do NOT re-seed when
  // myRatings updates on its own (polling tick during the same wine):
  // that would clobber an in-progress edit if another tab committed
  // underneath. Trade-off accepted: a cross-device update during
  // typing isn't visible until the user swaps away and back.
  //
  // We skip the very first run (mount-time seeding already happened
  // via useState initializers) via a ref-flag pattern to avoid the
  // brief re-set that would otherwise discard any rating typed during
  // initial layout/hydration.
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

  // URL sync — only when the modal owns the page. The modal can open
  // from two paths: `/session/<C>/rate/<wineId>` (modal IS the page —
  // syncing keeps refresh/share consistent), or as an overlay over
  // `/session/<C>/wines` or similar (modal is overlay — syncing would
  // reroute the underlying page and break the "close = back to wines"
  // mental model). The mount-time check captures which mode applies;
  // we only emit router.replace in the page-mode case.
  const router = useRouter()
  const pathname = usePathname()
  // Snapshot at mount: did we open as the page, or as an overlay?
  // The /rate route's path matches `/session/<C>/rate/<wineId>` —
  // any tail segment past /rate/ implies the modal is the page.
  const urlOwnedRef = useRef<boolean>(false)
  useEffect(() => {
    urlOwnedRef.current = /\/session\/[^/]+\/rate\/[^/]+/.test(pathname)
    // mount-only — capture entry mode once and ignore later route changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!urlOwnedRef.current) return
    const target = sessionPath(code, `rate/${activeWineId}`)
    if (pathname !== target) router.replace(target)
  }, [activeWineId, code, pathname, router])

  // Preload neighbouring wine images so the swap renders without a
  // visible image fetch. Browser caches the bytes; the next mount of
  // the WineInfoPane's <img> reads from cache. Trivial side effect —
  // `new Image()` triggers the GET and we don't need the result.
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

  // Pull-to-swap gesture (touch only). The hook listens on the
  // scroll container for pointer drags past the top or bottom
  // boundary. Past the threshold, it fires onSwapPrev / onSwapNext —
  // same path as the prev/next buttons. The returned pullDistance +
  // boundary feed the visual indicator below. Wheel/desktop
  // navigation is handled separately via arrow keys.
  // scrollRef is declared above (near per-wine state) so the
  // activeWineId-change effect can reset scrollTop on swap.
  // Slide-in-flight state at this scope so usePullToSwap can be
  // disabled during the 340ms window. iOS#2 fix: pointerEvents:none
  // on scrollRef doesn't gate touch events on iOS Safari — the hook
  // would still see touchstart/touchmove mid-slide and could queue a
  // second swap that interrupts the first one's clear-timeout.
  const slideActive = !!outgoing
  const { pullDistance, boundary } = usePullToSwap({
    containerRef: scrollRef,
    isFirst: isFirstWine,
    isLast: isLastWine,
    disabled: saving || slideActive,
    onSwapPrev: () => prevWineId && commitAndSwap(prevWineId),
    onSwapNext: () => nextWineId && commitAndSwap(nextWineId),
  })

  // Drive the slide track's y from pullDistance during the pull
  // gesture (the rubber-band). When NOT in a slide, slideY tracks
  // pullDistance directly. On release below threshold, pullDistance
  // resets to 0 and slideY springs back via a short animate(). The
  // slide animation owns slideY during commitAndSwap, so we skip
  // sync while outgoing is set.
  useEffect(() => {
    if (outgoing) return
    if (pullDistance === 0 && slideY.get() !== 0) {
      // Spring back from a sub-threshold pull release.
      const controls = animate(slideY, 0, { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] })
      return () => controls.stop()
    }
    slideY.set(pullDistance)
  }, [pullDistance, outgoing, slideY])

  // Ref on the brought-by callout — used to (1) scroll the expanded
  // preview into view if the user had scrolled past the callout
  // before opening it, and (2) detect outside-clicks so the floating
  // preview dismisses like any other popover.
  const broughtByRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!provenanceOpen) return
    broughtByRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    function onDoc(e: MouseEvent) {
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
  }, [provenanceOpen])

  // NOTE: no early-return here even when `wine` is undefined. The
  // hooks declared further down (beforeunload guard, dirty-guard
  // registration, lastSwap auto-dismiss) MUST run on every render;
  // returning early would short-circuit those hooks and produce a
  // "Rendered fewer hooks than expected" crash on the second render
  // after a polling tick delivers a wines array without the current
  // activeWineId (e.g. host deleted the wine from another tab).
  // Instead, derive wine-dependent values defensively (optional chain
  // / safe defaults) and gate the JSX at the bottom with a ternary.

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
  const blockedByMe = !!adderIdentity && blocksOut.has(adderIdentity)
  const blockingMe = !!adderIdentity && blocksIn.has(adderIdentity)
  const provenanceMode: ProvenanceRenderMode =
    !adderIdentity         ? 'plain'
    : adderIsMe            ? 'clickable'   // self — opens own profile preview, "· you" suffix from isSelf prop
    : blockedByMe && blockingMe ? 'anon-style'  // mutual
    : blockedByMe          ? 'blocked-by-me'
    : blockingMe           ? 'anon-style'
    : 'clickable'
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

  // Centralized close path. If the rate form is dirty and the user
  // initiated the close from somewhere other than the explicit commit
  // button, open the confirm modal. Otherwise close immediately.
  //
  // While a commit POST is in flight (`saving`), close requests are
  // ignored entirely — closing here would race the awaited fetch and
  // could let a Discard tap on a reopened confirm fire onClose while
  // the original POST still completes (rating gets committed despite
  // the user choosing Discard).
  function requestClose() {
    if (saving) return
    if (dirty) setPendingClose(true)
    else onClose()
  }

  // browser-level guard for tab close / refresh. Best-effort: mobile
  // Safari ignores beforeunload, but desktop browsers show their
  // generic "leave site?" prompt.
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

  // Low-level commit: POST a specific wine's rating value. Returns
  // true on success, false on failure. Sets `saving`/`commitError`
  // state but does NOT touch `activeWineId` / `onClose` / `refresh` —
  // those are the caller's concern.
  //
  // Split out from the original `commitRating` so we can reuse it for
  // three different higher-level flows: save-and-close, save-and-swap-
  // to-next-wine (via prev/next buttons or pull gesture), and the
  // future auto-commit-on-pull. Each wraps this primitive with its
  // own post-success behavior.
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

  // Save the current rating and close the modal. The original
  // commitRating behavior — used by the outer Cancel/Commit flow when
  // the user is done rating and wants out. On the last wine, the
  // primary CTA "Save & close" routes here too.
  async function commitRating(): Promise<boolean> {
    const ok = await commitWineRating(activeWineId, rating)
    if (ok) {
      refresh()
      onClose()
    }
    return ok
  }

  // Detect whether the local rating actually carries content worth
  // saving. Lets navigation actions skip a no-op POST when the user
  // hasn't typed anything on the active wine (e.g. they tap → on Wine
  // info without ever touching Rate).
  function hasContent(value: RatingValue): boolean {
    return value.score > 0
      || Object.values(value.flavors).some(v => v > 0)
      || value.notes.trim() !== ''
  }

  // Save the current rating (only if `dirty` — i.e. it carries content
  // AND differs from `existing`) and swap to a different wine. Used by
  // the prev/next buttons in the footer, the pull gesture, and the
  // primary CTA when there's a next wine.
  //
  // The `dirty` gate avoids re-POSTing identical ratings on every
  // swap — a user opening an existing rating and tapping Save & next
  // without touching anything would otherwise fire a no-op write and
  // surface the bubble for unmodified data. With the gate, those
  // browse-only swaps are silent.
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
    // Single-flight gate — synchronous ref flips before React commits
    // `saving=true`. Under arrow-key autorepeat or rapid double-taps,
    // multiple invocations can enter the function body before the
    // saving-state-driven button disable kicks in. Without this gate
    // the same wine's POST can race itself.
    if (commitInFlightRef.current) return
    commitInFlightRef.current = true
    try {
      const fromWineId = activeWineId
      const fromWine = wine
      const fromRating = rating
      const fromIdx = currentIndex
      const toIdx = wines.findIndex(w => w.id === targetWineId)
      // Snapshot pull-distance NOW, before any await. usePullToSwap's
      // touchend handler calls reset() right after firing onSwap* — if
      // we wait for the async commit to resolve before reading
      // pullDistance, by then React has rendered with pullDistance=0
      // and the scrollRef has visibly snapped back from peak-pull.
      // Capturing here keeps the continuous-handoff feel.
      const fromPull = pullDistance
      // Fire the slide BEFORE the network commit. iOS#1 fix: in the
      // dirty path, awaiting the POST first means usePullToSwap's
      // reset() flushes pullDistance=0 to React before `outgoing` is
      // set, producing a visible 200ms snap-back to translateY(0)
      // followed by a jump to the slide start. By setting `outgoing`
      // synchronously here, the scrollRef's transform stays under our
      // control across the commit await — no snap-back, no visible
      // glitch on slow networks. If the commit later FAILS, the slide
      // has already played; we surface the error inline (commitError)
      // and leave activeWineId untouched. Acceptable: the failure
      // case is rare and the wine pane content is the same identity-
      // wise — the user just sees the slide land then an error appear.
      const reduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const willAnimate = !reduced && fromIdx >= 0 && toIdx >= 0
        && fromIdx !== toIdx && scrollRef.current != null
      let slideAnim: ReturnType<typeof animate<number>> | null = null
      if (willAnimate) {
        const H = scrollRef.current!.clientHeight
        slideHeightRef.current = H
        const direction = toIdx > fromIdx ? 'up' : 'down'
        setOutgoing({
          wineId: fromWineId,
          pane,
          rating: fromRating,
          direction,
          fromPullDistance: fromPull,
        })
        // Track layout in the JSX:
        //   - direction='up' → [OLD pane, NEW pane]. OLD at track-y 0..H,
        //     NEW at track-y H..2H. y starts at fromPull (continuing pull
        //     motion) and animates to -H (OLD exits top, NEW arrives).
        //   - direction='down' → [NEW pane, OLD pane]. NEW at 0..H, OLD
        //     at H..2H. y starts at -H+fromPull and animates to 0 (NEW
        //     arrives from above, OLD exits bottom).
        // Both panes are framer flex children. They cannot drift apart.
        const startY = direction === 'up' ? fromPull : -H + fromPull
        const endY = direction === 'up' ? -H : 0
        slideY.set(startY)
        slideAnim = animate(slideY, endY, {
          duration: 0.3,
          ease: [0.25, 0.1, 0.25, 1],  // ease-out
          onComplete: () => {
            // Reset slideY BEFORE clearing outgoing. When `outgoing`
            // clears, the track collapses from 2 children (OLD pane +
            // scrollRef) back to 1 (just scrollRef occupying full
            // wrapper via flex:1). The translate must be 0 by that
            // point or scrollRef will be off-screen (shifted by ±H)
            // and the user sees a blank viewport, then a spring-back
            // from the pull-sync effect — a visible "rubber-band in
            // from the top" glitch (frames 91-102 in the test video).
            slideY.set(0)
            setOutgoing(null)
          },
        })
      }
      let didCommit = false
      if (dirty) {
        const ok = await commitWineRating(fromWineId, fromRating)
        if (!ok) {
          // Commit failed — abort the slide before it confuses the
          // user. Without this, the snapshot has already played and
          // the user sees a phantom "wine slides out then back to the
          // same wine" effect on top of the commitError.
          if (slideAnim) slideAnim.stop()
          slideY.set(0)
          setOutgoing(null)
          return
        }
        refresh()
        didCommit = true
      }
      // Reset scroll BEFORE swapping activeWineId so the new wine
      // mounts at scrollTop=0 in the same frame the slide enters.
      // Otherwise the activeWineId effect resets scrollTop after the
      // new pane has rendered, which on iOS can cause a one-frame
      // paint at the wrong position followed by the slide (iOS#4).
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
      commitInFlightRef.current = false
    }
  }

  // Auto-dismiss the Go-back bubble after 5s. Reset whenever
  // `lastSwap` changes (covers both "set to a fresh swap" and "user
  // cleared it via Go back").
  useEffect(() => {
    if (!lastSwap) return
    const t = setTimeout(() => setLastSwap(null), 5000)
    return () => clearTimeout(t)
  }, [lastSwap])

  // Resolve neighbouring wine ids relative to the current position.
  // Returns null at the list bounds. Computed inline at render rather
  // than memoized — wines array is small, lookups are O(n) but n<30.
  const prevWineId: string | null = !isFirstWine ? wines[currentIndex - 1].id : null
  const nextWineId: string | null = !isLastWine ? wines[currentIndex + 1].id : null

  // Keyboard navigation on desktop. Arrow keys move between wines.
  // ← previous, → next. Wheel-driven swap was removed (see
  // usePullToSwap header), so this is how desktop users navigate
  // without the buttons.
  //
  // Ignored when:
  //   - Any modifier key is held (Cmd/Ctrl/Alt/Shift) — reserved for
  //     browser/system shortcuts.
  //   - `saving` is true — same single-flight guard as the buttons.
  //   - Another modal is on top of WineModal (SessionPanel,
  //     UserPanel, or any future overlay). Gated via the modal
  //     stack depth from Modal.tsx.
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
      if (saving) return
      // Topmost-modal gate. If something is open ON TOP of WineModal
      // — SessionPanel, UserPanel, or any future overlay — the arrow
      // keys belong to that surface, not us. WineModal's own outer
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
          : `Delete failed (${res.status}). Try again.`
        setCommitError(msg)
        setSaving(false)
        return
      }
      setSaving(false)
      refresh()
      onClose()
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

  // Wine missing — most often because a host deleted it from another
  // tab and the polling tick just delivered the updated wines array.
  // This early return runs AFTER all hooks above, so React's hook
  // sequence stays stable across renders. Once the parent observes
  // the deletion via its own polling, it should close the modal; in
  // the meantime we show a minimal placeholder so the user isn't
  // stuck staring at a broken layout.
  if (!wine) {
    return (
      <Modal onClose={onClose} maxWidth={400}>
        <p style={{padding:16,color:'var(--fg-dim)',fontSize:13}}>Wine not found.</p>
        <button className="btn-g" onClick={onClose}>close</button>
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
    const blkOut = !!adderId && blocksOut.has(adderId)
    const blkIn = !!adderId && blocksIn.has(adderId)
    const mode: ProvenanceRenderMode =
      !adderId               ? 'plain'
      : adderMe              ? 'clickable'
      : blkOut && blkIn      ? 'anon-style'
      : blkOut               ? 'blocked-by-me'
      : blkIn                ? 'anon-style'
      :                        'clickable'
    const clickable = interactive && isLoggedIn && (mode === 'clickable' || mode === 'blocked-by-me')
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
    <Modal onClose={requestClose} maxWidth={620} maxHeight="90svh" minHeight="90svh">
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
            fontSize:15,fontWeight:700,color:'var(--fg-warm)',
            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
            letterSpacing:'-0.005em',
          }}>{wine.name}</span>
          {wine.vintage && (
            <span style={{
              fontFamily:'var(--mono)',fontSize:11,color:'var(--fg-dim)',
              letterSpacing:'0.06em',flexShrink:0,
            }}>{wine.vintage}</span>
          )}
        </div>
        {isLoggedIn && (
          <button
            onClick={toggleBookmark}
            title={bookmarked ? 'remove from saved' : 'save wine'}
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
            <span>{bookmarked ? 'Saved' : 'Save'}</span>
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

      {/* Scrollable body. Pull-to-swap gesture detection lives here:
          dragging past the top boundary loads the previous wine,
          past the bottom boundary loads the next. `overscroll-behavior:
          contain` prevents the browser's native page-pull-to-refresh
          from interfering on mobile. `touch-action: pan-y` is
          permanent so iOS handles native scroll + momentum; pull
          engages via touchmove preventDefault on the first qualifying
          move (see usePullToSwap). Score slider and flavor bars use
          horizontal-intent detection in their own pointer handlers
          to claim only horizontal drags. */}
      {/* Pullable region — wrapper that lets us anchor the pull
          indicator at the scroll container's edges without the
          indicator inheriting the body's rubber-band translateY.
          The inner ref'd div carries the transform; the indicator
          (rendered as a sibling further down) is positioned
          absolutely against this wrapper, so it stays pinned to the
          edge as the body slides. */}
      <div style={{
        flex:1,minHeight:0,position:'relative',
        display:'flex',flexDirection:'column',
        // Always clip — during slide the snapshot extends past wrapper
        // bounds; outside slide nothing should escape anyway, so a
        // permanent overflow:hidden is safer than toggling (which
        // would invalidate stacking on iOS Safari each toggle).
        overflow:'hidden',
      }}>
      {/* SLIDE TRACK (framer-motion):
          A vertical "track" holds the OLD snapshot and the LIVE
          scrollRef as flex children stacked top-to-bottom. The track's
          `y` motion value (slideY) is animated when a swap fires.
          Because both panes are children of the same translating
          parent, they cannot drift apart — overlap is geometrically
          impossible. Each pane is height: H, content anchored to its
          top edge; empty space below content is naturally part of
          the pane (matches the rest-state layout, no visual jump).

          Direction 'up' (next wine, NEW from below):
            Track children: [OLD pane, scrollRef pane (NEW)].
            y starts at 0 + fromPull (OLD visible, continuing pull).
            y animates to -H (OLD exits top, scrollRef arrives).

          Direction 'down' (prev wine, NEW from above):
            Track children: [scrollRef pane (NEW), OLD pane].
            y starts at -H + fromPull (OLD visible at viewport top).
            y animates to 0 (scrollRef arrives, OLD exits bottom).

          Outside slide: only scrollRef is in the track and slideY=0.
          The pull-rubber-band drives slideY via the pullDistance
          effect below. scrollRef behaves identically to before for
          native iOS scroll + pull-to-swap.

          DOM order swap on direction: when direction='down' we want
          OLD ABOVE NEW visually but BELOW NEW in DOM order, so we
          conditionally swap children via React key. Both children
          remount across swaps, but scrollRef's ref+state are preserved
          because React tracks elements by component identity inside
          motion.div. */}
      <motion.div
        style={{
          flex:1,minHeight:0,
          display:'flex',flexDirection:'column',
          y: slideY,
        }}
      >
        {/* For direction='up' (next wine), OLD goes FIRST in the
            track so it sits at the top; scrollRef (NEW) comes after
            and is one viewport below initially. For direction='down'
            (prev wine), scrollRef (NEW) goes FIRST (above viewport
            initially), then OLD comes after to fill the top.

            Snapshot panes are content-anchored to their top edge with
            height: H so the track's flex layout puts each pane in a
            full-viewport slot — same as the rest-state. */}
        {outgoing && outgoing.direction === 'up' && (
          <div
            aria-hidden
            style={{
              height: slideHeightRef.current || '100%',
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
            // During slide, scrollRef is one cell of a track. Its
            // height must match slideHeightRef.current so the track
            // arithmetic (y = ±H) places it correctly. Outside slide
            // it consumes the wrapper via flex:1.
            ...(outgoing
              ? {
                  height: slideHeightRef.current,
                  flexShrink: 0,
                }
              : {
                  flex:1,minHeight:0,
                }),
            // ⚠️ LOAD-BEARING — DO NOT CHANGE without reading
            // docs/dev/ios-touch-gestures.md and components/wine/CLAUDE.md.
            // The three properties below (overflowY:auto +
            // overscrollBehavior:contain + touchAction:pan-y) are
            // required together for iOS Safari pull-to-swap to work
            // alongside native scroll + momentum. Removing or changing
            // ANY one of them silently breaks the gesture on iPhone.
            // The hook (usePullToSwap.ts) has a dev-mode runtime check
            // that yells if these are missing.
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
              height: slideHeightRef.current || '100%',
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
          of the scroll container (not a child), so the translateY
          rubber-band doesn't move it. Anchored to the pullable-region
          wrapper which has the same bounds as the scroll container.
          - Top + first wine     → "↑ Start of the list" (capped pull)
          - Top + not first      → "↑ Pull to load previous" / "Release to load previous"
          - Bottom + last wine   → "↓ Sorry to disappoint. That's the last one"
          - Bottom + not last    → "↓ Pull to load next" / "Release to load next"
          Position: absolute over the scroll container, pinned to the
          corresponding edge. Opacity tracks pull progress so the
          indicator fades in as the user drags. */}
      {pulling && boundary && (
        <div style={{
          position:'absolute',left:0,right:0,
          ...(boundary === 'top'
            ? { top:0, paddingTop:6 }
            : { bottom:0, paddingBottom:6 }),
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
            color: blocked
              ? 'var(--fg-faint)'
              : pullPast
                ? 'var(--accent)'
                : 'var(--fg-dim)',
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
            {existing && (
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

      {/* Uncommitted-rating confirm — modal-on-modal. Mounted via the
          shared Modal portal so it floats above this modal's backdrop
          rather than nesting in the same stacking context.
          Backdrop / Escape close ONLY this inner confirm — equivalent
          to "Keep editing". Outer modal stays mounted underneath; the
          modalStack in Modal.tsx routes Escape to the topmost.
          `pendingNavRef` is set when the confirm opens via an external
          nav attempt (bottom-nav, Leave, header). The three resolutions:
          - Commit success → run pendingNav so user reaches their target
          - Discard      → onClose + run pendingNav
          - Keep editing → clear pendingNav, stay in the modal. */}
      {pendingClose && (
        <Modal
          onClose={() => {
            if (saving) return
            pendingNavRef.current = null
            setPendingClose(false)
          }}
          maxWidth={420}
        >
          <div style={{
            fontSize:15,fontWeight:700,color:'var(--fg-warm)',
            marginBottom:8,letterSpacing:'-0.005em',
          }}>Save your rating?</div>
          <div style={{
            fontSize:13,color:'var(--fg-dim)',lineHeight:1.5,
            marginBottom:commitError ? 12 : 18,
          }}>You have unsaved changes on this wine.</div>
          {commitError && (
            <div style={{
              marginBottom:18,padding:'10px 12px',
              borderRadius:8,
              border:'1px solid rgba(184,64,64,0.5)',
              background:'rgba(184,64,64,0.08)',
              color:'rgba(220,90,90,1)',fontSize:12,lineHeight:1.4,
            }}>{commitError}</div>
          )}
          {/* Button order: Discard | Keep editing | Save (primary).
              Discard is two-press (matches the codebase destructive-
              button convention) so a thumb-drift onto it doesn't
              destroy work — the first tap only arms it. Save stays
              mounted until commitRating resolves; on success
              commitRating calls onClose() which unmounts the whole
              modal stack; on failure the inner confirm stays open
              with commitError surfaced above. */}
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <DiscardButton
              disabled={saving}
              onDiscard={() => {
                const nav = pendingNavRef.current
                pendingNavRef.current = null
                setPendingClose(false)
                onClose()
                if (nav) nav()
              }}
            />
            <button
              onClick={() => {
                if (saving) return
                pendingNavRef.current = null
                setPendingClose(false)
              }}
              disabled={saving}
              style={{
                flex:1,minWidth:0,
                display:'inline-flex',alignItems:'center',justifyContent:'center',
                background:'transparent',color:'var(--fg-dim)',
                border:'1px solid var(--border)',
                padding:'12px 14px',borderRadius:8,
                fontSize:11,letterSpacing:'0.08em',
                textTransform:'uppercase',fontWeight:600,
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >Keep editing</button>
            <button
              onClick={async () => {
                const ok = await commitRating()
                if (ok) {
                  // commitRating already fired onClose internally — but
                  // it ran BEFORE we got here, so the modal's already
                  // unmounting. The pendingNav still needs to fire so
                  // the user lands at the bottom-nav target. Read &
                  // clear the ref before invoking to guard against an
                  // accidental double-fire on rapid clicks.
                  const nav = pendingNavRef.current
                  pendingNavRef.current = null
                  setPendingClose(false)
                  if (nav) nav()
                }
              }}
              disabled={saving}
              style={{
                flex:1,minWidth:120,
                display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,
                background:'var(--accent)',color:'var(--bg)',
                border:'none',padding:'12px 16px',borderRadius:8,
                fontWeight:700,fontSize:11,letterSpacing:'0.08em',
                textTransform:'uppercase',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                boxShadow:'0 6px 24px -8px var(--accent)',
              }}
            >
              <CheckIcon size={14} stroke={2.2} />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
      </div>
    </Modal>
  )
}

// Tight icon-button for the rate-tab footer's destructive action.
// Two-press confirm (first tap arms with a red tint, second tap fires).
// Sits next to Cancel + Commit without stealing room from the primary CTA.
//
// Label is "Delete rating" / "Tap to delete" (was "Reset rating" / "Tap
// to confirm"). The original copy implied a local reset of typed values
// — but the action POSTs DELETE to the server and wipes the persisted
// rating row. The renamed copy reflects the actual destructive scope so
// a user with uncommitted typed edits understands that tapping here
// destroys the saved rating *and* drops what they typed (the modal closes
// after the DELETE), rather than thinking "Reset" just undoes their edits.
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
      <span>{armed ? 'Tap to delete' : 'Delete rating'}</span>
    </button>
  )
}

// Two-press destructive button for the uncommitted-rating confirm. Same
// visual language as ResetButton — first tap arms with the red border +
// "Tap to discard" copy, second tap within 3s fires `onDiscard`. The
// codebase's destructive convention (see ConfirmDeleteButton / DeleteMenuItem
// / ResetButton) is two-press; a one-tap Discard sitting next to a green
// Commit CTA was the misclick risk the UX review flagged.
function DiscardButton({
  onDiscard, disabled = false,
}: {
  onDiscard: () => void
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={() => {
        if (disabled) return
        if (armed) onDiscard()
        else setArmed(true)
      }}
      disabled={disabled}
      style={{
        display:'inline-flex',alignItems:'center',justifyContent:'center',
        background:'transparent',
        color: armed ? 'rgba(220,90,90,1)' : 'rgba(220,90,90,0.85)',
        border: `1px solid ${armed ? 'rgba(184,64,64,0.7)' : 'rgba(184,64,64,0.4)'}`,
        padding:'12px 14px',borderRadius:8,
        fontSize:11,letterSpacing:'0.08em',
        textTransform:'uppercase',fontWeight:600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        // Fixed width sized to the wider label ("Tap to discard") so
        // the row doesn't reflow when the button arms.
        width:142,flexShrink:0,
        transition:'border-color .15s, color .15s',
      }}
    >{armed ? 'Tap to discard' : 'Discard'}</button>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        position:'relative',background:'transparent',border:'none',
        padding:'12px 16px',
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
