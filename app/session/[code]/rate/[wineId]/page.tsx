import { WineListScreen } from '@/components/session/WineListScreen'

// Direct-URL entry into the rate modal. Renders the wine list with the
// rate modal pre-opened on the targeted wine. When the user closes the
// modal, they end up on the wine list (same layout) — the URL doesn't
// auto-update but a refresh would land them back here.
export default async function RatingPage({ params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { wineId } = await params
  return <WineListScreen initialRateWineId={wineId} />
}
