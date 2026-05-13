'use client'
import { Modal } from '@/components/ui/Modal'
import { DiscardButton } from '@/components/ui/DiscardButton'
import { CheckIcon } from '@/components/ui/icons'

interface Props {
  // Open/close state of the confirm. When false, nothing renders.
  open: boolean
  // Title at the top of the confirm. Task-specific copy from the caller
  // (e.g. "Save your rating?" / "Save your changes?").
  title: string
  // Sub-line under the title (e.g. "You have unsaved changes…").
  subtitle: string
  // Optional error banner — surfaces the most recent save failure
  // (network 5xx, validation 400) so the user can retry without
  // having to look elsewhere. Null/empty hides the banner.
  error?: string | null
  // Pending state on the Save button. Disables all three buttons +
  // dims them while a save POST is in flight.
  saving: boolean
  // Discard tap (after the two-press DiscardButton arms). Caller is
  // responsible for: clearing pendingNavRef, calling onClose, firing
  // pendingNav if it was set, then setting pendingClose=false.
  onDiscard: () => void
  // "Keep editing" tap. Caller clears pendingNavRef + setPendingClose(false).
  onKeep: () => void
  // Save tap. Should run the commit/save flow and resolve to true on
  // success, false on failure. On success caller fires pendingNav if
  // set + closes the confirm; on failure the confirm stays open and
  // surfaces the error via the `error` prop.
  onSave: () => Promise<boolean>
  // Called when the confirm's own backdrop/Escape fires (modal-on-modal).
  // Equivalent to "Keep editing" — pendingNavRef cleared, pendingClose
  // false. Caller typically gates on `saving`.
  onDismiss: () => void
}

// Shared modal-on-modal "unsaved changes" confirm used by WineModal
// (uncommitted-rating prompt) and AddWineModal (uncommitted-wine-
// metadata prompt). Three resolutions:
//   - Discard      → caller's onDiscard runs (after the two-press
//                    DiscardButton arms + confirms)
//   - Keep editing → caller's onKeep runs (closes the confirm only)
//   - Save         → caller's onSave runs; on success the caller
//                    chains its own post-save flow (e.g. fire
//                    pendingNav, unmount outer modal); on failure the
//                    confirm stays open with `error` surfaced.
// Backdrop / Escape on the confirm fires onDismiss (= Keep editing
// semantics: just close the confirm, no nav).
//
// The button order (Discard | Keep editing | Save) and the inline
// styles are locked so the two consumers stay visually consistent.
// Don't move the DiscardButton — its two-press semantics depend on
// being clearly separated from the primary Save CTA.
export function UnsavedChangesConfirm({
  open, title, subtitle, error, saving,
  onDiscard, onKeep, onSave, onDismiss,
}: Props) {
  if (!open) return null
  return (
    <Modal onClose={onDismiss} maxWidth={420}>
      <div style={{
        fontSize:15,fontWeight:700,color:'var(--fg-warm)',
        marginBottom:8,letterSpacing:'-0.005em',
      }}>{title}</div>
      <div style={{
        fontSize:13,color:'var(--fg-dim)',lineHeight:1.5,
        marginBottom: error ? 12 : 18,
      }}>{subtitle}</div>
      {error && (
        <div style={{
          marginBottom:18,padding:'10px 12px',
          borderRadius:8,
          border:'1px solid rgba(184,64,64,0.5)',
          background:'rgba(184,64,64,0.08)',
          color:'rgba(220,90,90,1)',fontSize:12,lineHeight:1.4,
        }}>{error}</div>
      )}
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <DiscardButton disabled={saving} onDiscard={onDiscard} />
        <button
          onClick={() => { if (!saving) onKeep() }}
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
          onClick={() => { if (!saving) onSave() }}
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
  )
}
