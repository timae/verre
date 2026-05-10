'use client'
import { useRouter } from 'next/navigation'
import { Modal } from '@/components/ui/Modal'
import { AccountSettings } from '@/components/me/AccountSettings'
import { DashboardSettings } from '@/components/me/DashboardSettings'

interface Props {
  onClose: () => void
}

export function AccountSettingsModal({ onClose }: Props) {
  const router = useRouter()
  // router.refresh() so SSR-rendered surfaces (header, feed authors)
  // pick up the new display name; AccountSettings' NextAuth update()
  // already refreshed JWT-driven client state.
  function handleSaved() {
    onClose()
    router.refresh()
  }
  return (
    <Modal onClose={onClose} maxWidth={600} maxHeight="90vh">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          Settings
        </div>
        <button className="btn-s" onClick={onClose} style={{ fontSize: 9 }}>close</button>
      </div>
      <div className="panel">
        <div className="panel-hdr">account</div>
        <AccountSettings onSaved={handleSaved} />
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <DashboardSettings />
      </div>
    </Modal>
  )
}
