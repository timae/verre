'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from '@/components/ui/Modal'
import { AccountSettings } from '@/components/me/AccountSettings'
import { DashboardSettings } from '@/components/me/DashboardSettings'

// Rendered in the same slot the FollowButton occupies for non-self
// viewers. On wide viewports it mirrors FollowButton's footprint
// (minWidth 110 + "settings" label) so the layout matches across
// profile types. On narrow viewports the label collapses — the gear
// icon alone is enough, and the saved horizontal space matters on a
// phone where the avatar/name/level take most of the row.
export function ProfileSettingsButton() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  // After a successful AccountSettings save, close the modal and trigger
  // an SSR re-render so the new display name flows through to the
  // profile header, the WineIdentity rows in the check-in feed, and
  // anywhere else the SSR shell embedded the user name. NextAuth's
  // `update()` already refreshed the JWT-driven client state — this
  // closes the loop for server-rendered surfaces.
  function handleSaved() {
    setOpen(false)
    router.refresh()
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-s"
        aria-label="Settings"
        style={{
          width: 'auto', marginTop: 0, padding: '10px 14px',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span className="hide-narrow">settings</span>
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} maxWidth={600} maxHeight="90vh">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
              Settings
            </div>
            <button className="btn-s" onClick={() => setOpen(false)} style={{ fontSize: 9 }}>close</button>
          </div>
          <div className="panel">
            <div className="panel-hdr">account</div>
            <AccountSettings onSaved={handleSaved} />
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <DashboardSettings />
          </div>
        </Modal>
      )}
    </>
  )
}
