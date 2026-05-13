'use client'
import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react'

// Cross-cutting dirty-state guard. A component (e.g. WineModal) that
// owns an in-progress form registers a guard callback while it's
// mounted. Navigation surfaces (bottom-nav Link, Leave button, header
// logo, session/user panel buttons) consult the guard via
// `attemptNav(proceed)`: if the guard fires a prompt, the registered
// callback receives a `proceed` function the prompt's Discard branch
// can invoke to actually perform the nav. If no guard is registered
// (or dirty is false), `proceed` runs immediately.
//
// Why a separate module from SessionShell: SessionShell already owns a
// large context; this primitive is self-contained, framework-agnostic,
// and could be reused by AddWineModal / settings forms / etc. later.
//
// `beforeunload` (browser tab close / refresh) is NOT routed through
// here — components that need it register a `window.addEventListener`
// directly (see WineModal). This guard is for client-side navigations
// inside the app where the guard component is mounted.

type Guard = {
  // Called when a navigation is attempted while this guard is active.
  // The guard renders its own UI to ask the user; it calls `proceed()`
  // if the user chooses to navigate, or does nothing to keep them put.
  onAttempt: (proceed: () => void) => void
  // Snapshot reader — when this returns false, the nav goes through
  // without invoking onAttempt. Read at attempt time (not registration
  // time) so the latest state wins.
  isDirty: () => boolean
}

type Ctx = {
  // Components register a guard on mount, return the unregister fn.
  register: (g: Guard) => () => void
  // Navigation surfaces call this with the action they want to perform.
  // If a dirty guard is registered, it gets a chance to intercept; the
  // proceed callback runs only if the guard allows (or no guard exists).
  attemptNav: (proceed: () => void) => void
}

const DirtyGuardCtx = createContext<Ctx | null>(null)

export function DirtyGuardProvider({ children }: { children: ReactNode }) {
  // Single-slot. Multiple modals stacking dirty state is out of scope —
  // the outer caller of WineModal is the only nav surface that could
  // currently host one. If that changes, expand to an array and chain
  // attempts in registration order.
  const guardRef = useRef<Guard | null>(null)

  const register = useCallback((g: Guard) => {
    guardRef.current = g
    return () => {
      // Only clear if the slot still holds *this* guard — protects against
      // late unmount cleanup overwriting a newer registration.
      if (guardRef.current === g) guardRef.current = null
    }
  }, [])

  const attemptNav = useCallback((proceed: () => void) => {
    const g = guardRef.current
    if (g && g.isDirty()) {
      g.onAttempt(proceed)
      return
    }
    proceed()
  }, [])

  return (
    <DirtyGuardCtx.Provider value={{ register, attemptNav }}>
      {children}
    </DirtyGuardCtx.Provider>
  )
}

// Returns null when used outside a provider — callers should treat
// null as "no guard available, navigate immediately". This lets the
// hook be used by components mounted anywhere (header, nav) without
// forcing every consumer to live under the provider.
export function useDirtyGuard(): Ctx | null {
  return useContext(DirtyGuardCtx)
}
