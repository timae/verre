'use client'
import { WineModal } from '@/components/wine/WineModal'

interface Props { wineId: string; onClose: () => void }

// Thin wrapper: existing call sites (WineListScreen, the /rate/[wineId]
// direct-link route) still open this surface and expect a rate-first
// flow. WineModal is the actual implementation; this just picks the
// `rate` pane as the entry point.
//
// Step 7+ will introduce the Wines tab callers that mount WineModal
// directly with `initialPane="info"`.
export function RatingScreen({ wineId, onClose }: Props) {
  return <WineModal wineId={wineId} initialPane="rate" onClose={onClose} />
}
