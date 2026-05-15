'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from '@/components/ui/Modal'
import { UnsavedChangesConfirm } from '@/components/ui/UnsavedChangesConfirm'
import { AccountSettings, type AccountSettingsApi } from '@/components/me/AccountSettings'
import { DashboardSettings } from '@/components/me/DashboardSettings'

interface Props {
  onClose: () => void
}

// Settings modal chrome mirrors <WineModal>: sticky header with title +
// X-close, scrollable body with the per-section panels, sticky footer
// with a Save action that commits the account form. Other sections
// (visibility, blocked, danger, dashboard) auto-apply or commit per-row
// — only the account form has a pending-changes shape that needs an
// explicit Save, hence the single footer button.
//
// Dirty guard: close attempts (X, Escape, backdrop) with unsaved
// account changes route through the shared <UnsavedChangesConfirm>
// (same primitive WineModal + AddWineModal use). Three resolutions:
// Discard / Keep editing / Save-and-close.
export function AccountSettingsModal({ onClose }: Props) {
  const router = useRouter()
  const [api, setApi] = useState<AccountSettingsApi | null>(null)
  const [pendingClose, setPendingClose] = useState(false)
  // "Saved" pulse on the Save button — between save success and the
  // modal closing, the button label shows "✓ Saved" for ~700ms so the
  // user sees confirmation instead of the modal vanishing instantly.
  const [savedPulse, setSavedPulse] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  function handleSaved() {
    // Show "✓ Saved" briefly, then close and refresh.
    setSavedPulse(true)
    savedTimer.current = setTimeout(() => {
      setSavedPulse(false)
      onClose()
      router.refresh()
    }, 700)
  }

  // Footer Save: no-op (no dirty) → close. Dirty → drive AccountSettings
  // save, which calls handleSaved on success → savedPulse → close.
  async function handleSaveClick() {
    if (!api) return
    if (!api.dirty) { onClose(); return }
    await api.save()
  }

  // Close attempt with dirty state arms the confirm modal-on-modal.
  // Clean close (or already-confirming) closes directly.
  function requestClose() {
    if (api?.dirty && !pendingClose) {
      setPendingClose(true)
      return
    }
    onClose()
  }

  return (
    <>
      <Modal onClose={requestClose} maxWidth={600} minHeight="90svh" maxHeight="90svh">
        <div style={{
          display: 'flex', flexDirection: 'column',
          flex: 1, minHeight: 0,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
            marginBottom: 14, paddingBottom: 14,
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
              Settings
            </div>
            <button
              onClick={requestClose}
              aria-label="Close"
              style={{
                background: 'transparent', border: 'none',
                width: 32, height: 32, borderRadius: 8,
                color: 'var(--fg-dim)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontSize: 18, lineHeight: 1,
              }}
            >×</button>
          </div>

          <div style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            marginRight: -8, paddingRight: 8,
          }}>
            <div className="panel">
              <div className="panel-hdr">account</div>
              <AccountSettings onSaved={handleSaved} onReady={setApi} />
            </div>
            <div className="panel" style={{ marginTop: 16 }}>
              <DashboardSettings />
            </div>
          </div>

          {/* Footer — Save. Error from the account form surfaces above
              the button so it's visible regardless of scroll position.
              Success is shown inline on the button itself (savedPulse). */}
          <div style={{
            marginTop: 14, paddingTop: 14,
            borderTop: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
          }}>
            {api?.error && (
              <p style={{ color: '#e07070', fontSize: 11, margin: 0 }}>{api.error}</p>
            )}
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={!api || api.saving || savedPulse}
              className="btn-p"
              style={{ flex: 1, marginTop: 0 }}
            >
              {savedPulse ? '✓ changes saved' : api?.saving ? 'saving…' : 'Save'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal-on-modal dirty guard. Same primitive WineModal and
          AddWineModal use. Save here routes back through the account
          form's save → handleSaved → close. */}
      <UnsavedChangesConfirm
        open={pendingClose}
        title="Save your changes?"
        subtitle="You have unsaved changes to your account."
        error={api?.error || null}
        saving={!!api?.saving}
        onDismiss={() => { if (!api?.saving) setPendingClose(false) }}
        onKeep={() => setPendingClose(false)}
        onDiscard={() => { setPendingClose(false); onClose() }}
        onSave={async () => {
          if (!api) return false
          const ok = await api.save()
          // On success: AccountSettings already fired onSaved →
          // savedPulse + scheduled outer-modal close. Close the confirm
          // now so the user sees the saved-pulse on the outer Save
          // button before everything unmounts.
          if (ok) setPendingClose(false)
          return ok
        }}
      />
    </>
  )
}
