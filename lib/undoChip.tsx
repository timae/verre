'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sessionFetch } from '@/lib/sessionFetch'
import type { RatingValue } from '@/lib/rating'

// Session-shell-scoped undo chip. WineModal commits publish a chip
// here; the chip lives outside the modal so it survives modal close.
// That fixes two gaps the in-modal chip had: (1) tapping X on the
// modal dismissed the chip, (2) the Save & close path got NO chip at
// all because the modal unmounted before render could surface one.
//
// Single-slot — latest commit replaces any prior chip. A 7s timer
// auto-dismisses; the timer resets on every fresh publish so the user
// always gets a full window for the most recent action.
//
// Undo semantics mirror what WineModal used to do locally:
//   priorRating == null → first-engagement POST; undo is DELETE
//   priorRating != null → edit/overwrite; undo re-POSTs prior values
//
// When undo succeeds the provider calls `refresh` (server-state poll)
// and bumps `navTo` — a one-shot {wineId, nonce} signal. WineModal
// subscribes via `[undo?.navTo?.nonce]` and navigates internally when
// open; WineListScreen subscribes and opens the modal when closed.
// The nonce keying is load-bearing: a dep that also changes on
// internal modal navigation (like a `wineId` prop) would re-fire the
// effect at slide-end and snap back to a stale value.

export type UndoableCommit = {
  wineId: string
  wineName: string
  priorRating: RatingValue | null
}

type Ctx = {
  publish: (c: UndoableCommit) => void
  // Optional reader for the just-undone seed value. WineModal consumes
  // this when it mounts or swaps to a wine so the rate-pane shows the
  // restored state immediately instead of waiting for the polling
  // refresh. Returns null and clears the seed after first read.
  consumeUndoSeed: (wineId: string) => RatingValue | null
  // One-shot navigation signal. The provider bumps `nonce` on every
  // successful undo. Subscribers watch `[navTo?.nonce]` — NEVER any
  // dep that also changes on internal modal navigation (e.g. a prop
  // like `wineId`), which would re-fire the effect at slide-end and
  // snap the modal back to the stale value.
  navTo: { wineId: string; nonce: number } | null
}

const UndoCtx = createContext<Ctx | null>(null)

const DISMISS_MS = 7000

export function UndoChipProvider({
  code,
  refresh,
  children,
}: {
  code: string
  refresh: () => void
  children: ReactNode
}) {
  const [chip, setChip] = useState<(UndoableCommit & { pending: boolean }) | null>(null)
  const [navTo, setNavTo] = useState<{ wineId: string; nonce: number } | null>(null)
  const seedRef = useRef<{ wineId: string; value: RatingValue } | null>(null)

  const publish = useCallback((c: UndoableCommit) => {
    setChip({ ...c, pending: false })
  }, [])

  const consumeUndoSeed = useCallback((wineId: string): RatingValue | null => {
    const s = seedRef.current
    if (s && s.wineId === wineId) {
      seedRef.current = null
      return s.value
    }
    return null
  }, [])

  // Auto-dismiss. Skipped while undo is in-flight so the chip doesn't
  // disappear mid-op.
  useEffect(() => {
    if (!chip || chip.pending) return
    const t = setTimeout(() => setChip(null), DISMISS_MS)
    return () => clearTimeout(t)
  }, [chip])

  async function runUndo(c: NonNullable<typeof chip>): Promise<void> {
    setChip(prev => prev && prev.wineId === c.wineId ? { ...prev, pending: true } : prev)
    let ok = false
    try {
      if (c.priorRating == null) {
        const res = await sessionFetch(code, `/api/session/${code}/rate/${c.wineId}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        ok = res.ok
      } else {
        const res = await sessionFetch(code, `/api/session/${code}/rate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wineId: c.wineId, ...c.priorRating }),
        })
        ok = res.ok
      }
    } catch { ok = false }
    if (ok) {
      // Seed the restored value so WineModal's rate-pane renders it
      // immediately on next mount/swap, before server polling lands.
      // Mirror semantics: empty value when priorRating was null
      // (un-doing a first-engagement post = DELETE = back to "no rating").
      seedRef.current = {
        wineId: c.wineId,
        value: c.priorRating ?? { score: 0, flavors: {}, notes: '' },
      }
      refresh()
      // Bump the one-shot nav signal. WineModal navigates internally
      // when open; WineListScreen opens the modal when closed. The
      // nonce bumps even on same-wine consecutive undos so subscribers
      // observe the change.
      setNavTo(prev => ({ wineId: c.wineId, nonce: (prev?.nonce ?? 0) + 1 }))
    } else {
      // Chip just disappears; we have no inline error surface. Log so a
      // 429 / 500 / network drop isn't entirely silent in DevTools.
      console.warn('[undoChip] undo failed for wine', c.wineId)
    }
    // Guard: a fresh commit may have published a NEW chip during the
    // await. Don't stomp it. Only clear when the slot still holds OUR
    // chip (matched by wineId; same-wine re-publish would have updated
    // the entry in place via publish's latest-wins).
    setChip(prev => prev && prev.wineId === c.wineId ? null : prev)
  }

  // Memoize the context value so it doesn't get a new reference on
  // every render. `navTo` is intentionally in deps — that's the
  // signal subscribers watch.
  const value = useMemo(
    () => ({ publish, consumeUndoSeed, navTo }),
    [publish, consumeUndoSeed, navTo],
  )

  return (
    <UndoCtx.Provider value={value}>
      {children}
      {chip && typeof document !== 'undefined' && createPortal(
        <div
          role="status"
          onClick={() => { if (!chip.pending) runUndo(chip) }}
          style={{
            position: 'fixed',
            top: 'max(16px, env(safe-area-inset-top))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 60,
            maxWidth: 'min(420px, calc(100vw - 32px))',
            width: 'max-content',
            padding: '10px 14px',
            display: 'flex', alignItems: 'center', gap: 12,
            border: '1px solid rgba(200,150,60,0.4)',
            background: 'var(--bg2)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            fontSize: 12, color: 'var(--fg-warm-soft)',
            cursor: chip.pending ? 'default' : 'pointer',
            opacity: chip.pending ? 0.6 : 1,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chip.priorRating == null ? 'Saved ' : 'Updated '}
            <span style={{ color: 'var(--fg-warm)', fontWeight: 600 }}>{chip.wineName}</span>
          </span>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              color: 'var(--accent)',
              border: '1px solid rgba(200,150,60,0.4)',
              padding: '6px 10px', borderRadius: 6,
              fontSize: 10, letterSpacing: '0.08em',
              textTransform: 'uppercase', fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <span>Undo</span>
          </span>
        </div>,
        document.body
      )}
    </UndoCtx.Provider>
  )
}

// Returns null outside a provider so callers (WineModal could in
// principle be mounted standalone, e.g. SavedWineModal) can degrade
// gracefully — they just don't publish a chip.
export function useUndoChip(): Ctx | null {
  return useContext(UndoCtx)
}
