import { WineListScreen } from '@/components/session/WineListScreen'

// Direct-URL entry into the rate modal. Renders the Rate tab's wine
// list (mode="rate" — no host controls visible behind the modal) with
// the rate modal pre-opened on the targeted wine. When the user closes
// the modal, WineListScreen replaces the URL to /rate so a refresh
// doesn't re-open the modal.
export default async function RatingPage({ params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { wineId } = await params
  return <WineListScreen mode="rate" initialRateWineId={wineId} />
}
