import { RatingScreen } from '@/components/session/RatingScreen'

export default function RatingPage({ params }: { params: Promise<{ code: string; wineId: string }> }) {
  return <RatingScreen params={params} />
}
