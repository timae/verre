import { NextRequest, NextResponse } from 'next/server'
import { checkRate, checkRates, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { redis } from '@/lib/redis'
import { resolveUser } from '@/lib/resolveUser'

// Read per request (the suite drives both upstream paths).
const googleKey = () => process.env.GOOGLE_PLACES_API_KEY
const QUERY_MAX = 100

export interface PlaceResult {
  id: string; name: string; address: string
  city: string; country: string; lat: number; lng: number; types: string[]
}

// Fetch + parse JSON with informative errors. Upstream APIs occasionally
// return HTML (rate limit pages, gateway timeouts, maintenance notices)
// instead of JSON; without these checks the failure surfaces as a generic
// `JSON.parse: Unexpected token` in the logs which tells you nothing about
// which upstream actually failed.
async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${label} returned ${res.status} ${res.statusText}`)
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) {
    const preview = (await res.text()).slice(0, 120)
    throw new Error(`${label} returned non-JSON content-type "${ct}": ${preview}`)
  }
  return res.json()
}

// POST /api/places: the location picker of the web check-in modal
// (components/social/CheckinModal.tsx → LocationPicker), reached only signed
// in (your feed, your own profile, your own post's edit); the app never calls
// it. A thin adapter over Google Places (when GOOGLE_PLACES_API_KEY is set) or
// OSM Overpass + Nominatim (the fallback).
//
// Signed in only (leak-fixes F1): every lookup can bill the Google key, and an
// autocomplete fans out to up to 7 billed calls (1 autocomplete + 6 place
// details). Limits after the 401: 30/min + 300/day per account, 120/min +
// 1,000/day per address (free accounts multiply the per-account caps, the
// per-address ones bound them), then an app-wide 2,000/day on the Google path
// only, charged after the per-caller limits and the input checks pass. Over
// it, and over Nominatim's 1 request a second for the WHOLE app (its usage
// policy), the picker gets no results (`[]`, never a 429): the user types the
// venue by hand. The real backstop is the Google console's daily quota
// (docs/dev/deployment.md § GOOGLE_PLACES_API_KEY).
//
// body: { type: 'nearby', lat, lng } | { type: 'autocomplete', query, lat?, lng? }
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const ip = getClientIp(req)
  const rl = await checkRates([
    { key: `rl:places:u:${userId}:1m`, max: 30, windowSeconds: 60 },
    { key: `rl:places:u:${userId}:1d`, max: 300, windowSeconds: 86400 },
    { key: `rl:places:ip:${ip}:1m`, max: 120, windowSeconds: 60 },
    { key: `rl:places:ip:${ip}:1d`, max: 1000, windowSeconds: 86400 },
  ])
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many place lookups. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } })
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const isNearby = body.type === 'nearby'
  const isAutocomplete = body.type === 'autocomplete'
  if (!isNearby && !isAutocomplete) return NextResponse.json({ error: 'type must be "nearby" or "autocomplete"' }, { status: 400 })
  const coordOk = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
  if (isNearby && (!coordOk(body.lat, 90) || !coordOk(body.lng, 180))) {
    return NextResponse.json({ error: 'lat and lng (numbers) required for nearby search' }, { status: 400 })
  }
  if (isAutocomplete) {
    const q = typeof body.query === 'string' ? body.query.trim() : ''
    if (!q) return NextResponse.json({ error: 'query required for autocomplete' }, { status: 400 })
    if (q.length > QUERY_MAX) return NextResponse.json({ error: `query must be at most ${QUERY_MAX} characters` }, { status: 400 })
    if ((body.lat != null && !coordOk(body.lat, 90)) || (body.lng != null && !coordOk(body.lng, 180))) {
      return NextResponse.json({ error: 'lat and lng must be valid coordinates' }, { status: 400 })
    }
    body.query = q
  }

  // Await inside the try so async errors from the upstream calls (Overpass
  // timeouts, malformed JSON, etc.) are caught here and surface as an empty
  // result set rather than an unhandled rejection → 500.
  try {
    const KEY = googleKey()
    if (KEY) {
      if (!(await checkRate('rl:places:global:1d', 2000, 86400)).allowed) return NextResponse.json({ results: [] })
      return await (isNearby
        ? googleNearby(KEY, body.lat as number, body.lng as number)
        : googleAutocomplete(KEY, body.query as string, body.lat as number | undefined, body.lng as number | undefined))
    }
    // Fallback: OpenStreetMap (Overpass + Nominatim) — free, no key required
    if (isNearby) return await overpassNearby(body.lat as number, body.lng as number)
    if (!(await nominatimSlot())) return NextResponse.json({ results: [] })
    return await nominatimSearch(body.query as string, body.lat as number | undefined, body.lng as number | undefined)
  } catch (err) {
    console.error('places error:', err)
    return NextResponse.json({ results: [] })
  }
}

// Nominatim's usage policy: 1 request a second for the whole application. A
// lookup WAITS for the next free second (the picker sends one 350 ms after each
// pause in typing, so refusing would drop a single user's own lookups), up to
// about 1.2 s; then it degrades to no results. Fails open like the limiter.
async function nominatimSlot(): Promise<boolean> {
  const until = Date.now() + 1200
  for (;;) {
    try {
      if (await redis.set('rl:places:nominatim:1s', '1', { NX: true, PX: 1000 })) return true
    } catch (err) {
      console.error('places: nominatim slot error', err)
      return true
    }
    if (Date.now() >= until) return false
    await new Promise(r => setTimeout(r, 100))
  }
}

// ── Google Places API ─────────────────────────────────────────

async function googleNearby(KEY: string, lat: number, lng: number) {
  const data = await fetchJson('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.addressComponents',
    },
    body: JSON.stringify({
      includedTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'food'],
      maxResultCount: 10,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } },
    }),
  }, 'google nearby') as { places?: Record<string, unknown>[] }
  return NextResponse.json({ results: (data.places ?? []).map(parseGooglePlace) })
}

async function googleAutocomplete(KEY: string, query: string, lat?: number, lng?: number) {
  const data = await fetchJson('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
    body: JSON.stringify({
      input: query,
      includedPrimaryTypes: ['bar', 'restaurant', 'wine_bar', 'liquor_store', 'cafe', 'establishment'],
      ...(lat && lng ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } } } : {}),
    }),
  }, 'google autocomplete') as { suggestions?: Record<string, unknown>[] }
  const results: PlaceResult[] = await Promise.all(
    (data.suggestions ?? []).slice(0, 6).map(async (s: Record<string, unknown>) => {
      const placeId = (s.placePrediction as Record<string, unknown>)?.placeId
      if (!placeId) return null
      const detail = await fetchJson(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,addressComponents' },
      }, 'google place detail') as Record<string, unknown>
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
  const data = await fetchJson('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
  }, 'overpass nearby') as { elements?: Record<string, unknown>[] }
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
  const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': `Verre/1.0 (${process.env.PUBLIC_HOSTNAME || 'self-hosted'})` },
  }, 'nominatim search') as Record<string, unknown>[]
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
