import { WineListScreen } from '@/components/session/WineListScreen'

// The Wines tab — the sole wine-list surface. Tapping a row opens
// the modal on the Wine Info pane; the inline "Rate" button on each
// unrated row (or the score chip on rated rows) opens the modal on
// the Rate pane directly. Host/cohost/provider see add-wine,
// drag-to-reorder, and (for hosts) reveal-all/hide-all controls.
export default function WinesPage() {
  return <WineListScreen />
}
