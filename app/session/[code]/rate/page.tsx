import { WineListScreen } from '@/components/session/WineListScreen'

// The Rate tab is the default landing for the session — same wine
// list as the Wines tab, but without host-management affordances
// (add wine, drag-to-reorder, per-row reveal/hide). Tapping a wine
// opens the modal with the rate pane first. Host/cohost/provider
// get a "manage wines" shortcut in the header that hops to the
// Wines tab.
export default function RatePickerPage() {
  return <WineListScreen mode="rate" />
}
