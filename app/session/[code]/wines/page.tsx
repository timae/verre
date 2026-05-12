import { WineListScreen } from '@/components/session/WineListScreen'

// The Wines tab — full wine-list management surface. Host/cohost see
// the "+ add wine", drag-to-reorder, and reveal-all/hide-all
// affordances; providers see only the add button (reorder is
// host-tier). Tapping a wine opens the modal with the info pane
// first (so the user lands on the wine's identity, not the rate
// form). The Rate tab handles the rate-first flow.
export default function WinesPage() {
  return <WineListScreen mode="manage" />
}
