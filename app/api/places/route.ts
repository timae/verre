import { NextRequest, NextResponse } from 'next/server'

const KEY = process.env.GOOGLE_PLACES_API_KEY

export interface PlaceResult {
  id: string; name: string; address: string
  city: string; country: string; lat: number; lng: number; types: string[]
}

// POST /api/places
// body: { type: 'nearby', lat, lng } | { type: 'autocomplete', query, lat?, lng? }
export async function POST(req: NextRequest) {
  const body = await req.json()
  try {
    if (KEY) {
      return body.type === 'nearby'
        ? googleNearby(body.lat, body.lng)
        : googleAutocomplete(body.query, body.lat, body.lng)
    } else {
      // Fallback: OpenStreetMap (Overpass + Nominatim) — free, no key required
      return body.type === 'nearby'
        ? overpassNearby(body.lat, body.lng)
        : nominatimSearch(body.query, body.lat, body.lng)
    }
  } catch (err) {
    console.error('places error:', err)
    return NextResponse.json({ results: [] })
  }
}

// ── Google Places API ─────────────────────────────────────────

async function googleNearby(lat: number, lng: number) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY!,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.addressComponents',
    },
    body: JSON.stringify({
      includedTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'food'],
      maxResultCount: 10,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } },
    }),
  })
  const data = await res.json()
  return NextResponse.json({ results: (data.places ?? []).map(parseGooglePlace) })
}

async function googleAutocomplete(query: string, lat?: number, lng?: number) {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY! },
    body: JSON.stringify({
      input: query,
      includedPrimaryTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'establishment'],
      ...(lat && lng ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } } } : {}),
    }),
  })
  const data = await res.json()
  const results: PlaceResult[] = await Promise.all(
    (data.suggestions ?? []).slice(0, 6).map(async (s: Record<string, unknown>) => {
      const placeId = (s.placePrediction as Record<string, unknown>)?.placeId
      if (!placeId) return null
      const detail = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: { 'X-Goog-Api-Key': KEY!, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,addressComponents' },
      }).then(r => r.json())
      return parseGooglePlace(detail)
    })
  ).then(r => r.filter(Boolean) as PlaceResult[])
  return NextResponse.json({ results })
}

function parseGooglePlace(p: Record<string, unknown>): PlaceResult {
  const components = (p.addressComponents as Record<string, unknown>[] ?? [])
  const city    = components.find((c: Record<string, unknown>) => (c.types as string[])?.includes('locality'))
  const country = components.find((c: Record<string, unknown>) => (c.types as string[])?.includes('country'))
  const loc = p.location as { latitude?: number; longitude?: number } | undefined
  return {
    id: String(p.id ?? ''),
    name: (p.displayName as { text?: string } | undefined)?.text ?? String(p.formattedAddress ?? ''),
    address: String(p.formattedAddress ?? ''),
    city: String((city as { longText?: string } | undefined)?.longText ?? ''),
    country: String((country as { shortText?: string } | undefined)?.shortText ?? ''),
    lat: loc?.latitude ?? 0, lng: loc?.longitude ?? 0,
    types: (p.types as string[] | undefined) ?? [],
  }
}

// ── OpenStreetMap fallback (no key required) ──────────────────

const OSM_VENUE_FILTER = '"amenity"~"^(bar|pub|restaurant|cafe|biergarten)$","name"'
const OSM_SHOP_FILTER  = '"shop"~"^(wine|alcohol|beverages)$","name"'

async function overpassNearby(lat: number, lng: number) {
  const q = `[out:json][timeout:10];(node[${OSM_VENUE_FILTER}](around:500,${lat},${lng});node[${OSM_SHOP_FILTER}](around:500,${lat},${lng}););out body 12;`
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
  })
  const data = await res.json()
  const results: PlaceResult[] = (data.elements ?? []).map((e: Record<string, unknown>) => {
    const tags = e.tags as Record<string, string> | undefined ?? {}
    return {
      id: String(e.id ?? ''),
      name: tags.name ?? tags['name:en'] ?? 'Unnamed venue',
      address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
      city: tags['addr:city'] ?? tags['addr:town'] ?? '',
      country: tags['addr:country'] ?? '',
      lat: Number(e.lat ?? 0), lng: Number(e.lon ?? 0),
      types: [tags.amenity ?? tags.shop ?? ''].filter(Boolean),
    }
  }).filter((r: PlaceResult) => r.name !== 'Unnamed venue')
  return NextResponse.json({ results })
}

async function nominatimSearch(query: string, lat?: number, lng?: number) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '6', addressdetails: '1',
    ...(lat && lng ? { viewbox: `${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}`, bounded: '1' } : {}),
  })
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': `Verre/1.0 (${process.env.PUBLIC_HOSTNAME || 'self-hosted'})` },
  })
  const data = await res.json() as Record<string, unknown>[]
  const results: PlaceResult[] = data.map(p => {
    const addr = p.address as Record<string, string> | undefined ?? {}
    const name = addr.amenity ?? addr.shop ?? addr.tourism ?? String(p.display_name ?? '').split(',')[0]
    return {
      id: String(p.place_id ?? ''),
      name,
      address: String(p.display_name ?? ''),
      city: addr.city ?? addr.town ?? addr.village ?? '',
      country: (addr.country_code ?? '').toUpperCase(),
      lat: Number(p.lat ?? 0), lng: Number(p.lon ?? 0),
      types: [addr.amenity ?? addr.shop ?? ''].filter(Boolean),
    }
  })
  return NextResponse.json({ results })
}
