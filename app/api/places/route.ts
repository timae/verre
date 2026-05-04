import { NextRequest, NextResponse } from 'next/server'

const KEY = process.env.GOOGLE_PLACES_API_KEY

export interface PlaceResult {
  id: string
  name: string
  address: string
  city: string
  country: string
  lat: number
  lng: number
  types: string[]
}

function notConfigured() {
  return NextResponse.json({ error: 'places_not_configured', results: [] }, { status: 200 })
}

// POST /api/places
// body: { type: 'nearby', lat, lng } | { type: 'autocomplete', query, lat?, lng? }
export async function POST(req: NextRequest) {
  if (!KEY) return notConfigured()

  const body = await req.json()

  try {
    if (body.type === 'nearby') {
      const { lat, lng } = body
      const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.addressComponents',
        },
        body: JSON.stringify({
          includedTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'food'],
          maxResultCount: 10,
          locationRestriction: {
            circle: { center: { latitude: lat, longitude: lng }, radius: 500 },
          },
        }),
      })
      const data = await res.json()
      const results: PlaceResult[] = (data.places ?? []).map((p: Record<string, unknown>) => parsePlace(p))
      return NextResponse.json({ results })
    }

    if (body.type === 'autocomplete') {
      const { query, lat, lng } = body
      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
        body: JSON.stringify({
          input: query,
          includedPrimaryTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'establishment'],
          ...(lat && lng ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } } } : {}),
        }),
      })
      const data = await res.json()
      const suggestions = data.suggestions ?? []

      // Fetch place details for each suggestion
      const results: PlaceResult[] = await Promise.all(
        suggestions.slice(0, 6).map(async (s: Record<string, unknown>) => {
          const placeId = (s.placePrediction as Record<string, unknown>)?.placeId
          if (!placeId) return null
          const detail = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
            headers: {
              'X-Goog-Api-Key': KEY,
              'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,addressComponents',
            },
          }).then(r => r.json())
          return parsePlace(detail)
        })
      ).then(r => r.filter(Boolean) as PlaceResult[])

      return NextResponse.json({ results })
    }

    return NextResponse.json({ error: 'invalid type' }, { status: 400 })
  } catch (err) {
    console.error('places error:', err)
    return NextResponse.json({ results: [] })
  }
}

function parsePlace(p: Record<string, unknown>): PlaceResult {
  const components = (p.addressComponents as Record<string, unknown>[] | undefined) ?? []
  const city = components.find((c: Record<string, unknown>) => (c.types as string[])?.includes('locality'))
  const country = components.find((c: Record<string, unknown>) => (c.types as string[])?.includes('country'))
  const loc = p.location as { latitude?: number; longitude?: number } | undefined
  return {
    id: String(p.id ?? ''),
    name: (p.displayName as { text?: string } | undefined)?.text ?? String(p.formattedAddress ?? ''),
    address: String(p.formattedAddress ?? ''),
    city: String((city as { longText?: string } | undefined)?.longText ?? ''),
    country: String((country as { shortText?: string } | undefined)?.shortText ?? ''),
    lat: loc?.latitude ?? 0,
    lng: loc?.longitude ?? 0,
    types: (p.types as string[] | undefined) ?? [],
  }
}
