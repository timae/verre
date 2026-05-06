'use client'
import { useState, useRef, useEffect, useCallback } from 'react'

interface PlaceResult {
  id: string; name: string; address: string; city: string
  country: string; lat: number; lng: number; types: string[]
}
interface LocationData { venueName?: string; city?: string; country?: string; lat?: number; lng?: number }
interface Props { value: LocationData; onChange: (v: LocationData) => void }

const TYPE_ICONS: Record<string, string> = {
  bar: '🍸', wine_bar: '🍷', restaurant: '🍽', liquor_store: '🥃', cafe: '☕',
}
function venueIcon(types: string[]) {
  for (const t of types) if (TYPE_ICONS[t]) return TYPE_ICONS[t]
  return '📍'
}

export function LocationPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState(value.venueName || '')
  const [results, setResults] = useState<PlaceResult[]>([])
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [open, setOpen] = useState(false)
  const [notConfigured, setNotConfigured] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    function close(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  async function searchVenues(q: string, lat?: number, lng?: number) {
    if (!q.trim() || q.length < 2) { setResults([]); return }
    setLoading(true)
    const res = await fetch('/api/places', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'autocomplete', query: q, lat, lng }),
    })
    const d = await res.json()
    setLoading(false)
    if (d.error === 'places_not_configured') { return }
    const r = d.results ?? []
    setResults(r)
    setOpen(r.length > 0)
  }

  function handleQueryChange(q: string) {
    setQuery(q)
    onChange({ ...value, venueName: q })
    clearTimeout(debounceRef.current)
    if (!notConfigured) {
      debounceRef.current = setTimeout(() => searchVenues(q, coords?.lat, coords?.lng), 350)
    }
  }

  async function useGeo() {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords
      setCoords({ lat, lng })
      setLocating(false)
      setLoading(true)
      const res = await fetch('/api/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'nearby', lat, lng }),
      })
      const d = await res.json()
      setLoading(false)
      if (false && d.error === 'places_not_configured') {
        setNotConfigured(true)
        try {
          const geo = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
          const g = await geo.json()
          onChange({ ...value, lat, lng, city: g.address?.city || g.address?.town || '', country: g.address?.country_code?.toUpperCase() || '' })
        } catch {}
        return
      }
      const r = d.results ?? []
      setResults(r)
      setOpen(r.length > 0)
    }, () => setLocating(false))
  }

  function selectPlace(p: PlaceResult) {
    setQuery(p.name)
    setOpen(false)
    setResults([])
    onChange({ venueName: p.name, city: p.city, country: p.country, lat: p.lat, lng: p.lng })
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
      <div className="fl" style={{ marginBottom: 8 }}>
        location <span style={{ opacity:.5, textTransform:'none', letterSpacing:0 }}>(optional)</span>
      </div>

      {/* Venue search with dropdown */}
      <div ref={dropRef} style={{ position:'relative', marginBottom:8 }}>
        <div className="field" style={{ margin:0, position:'relative' }}>
          <div className="fl">venue</div>
          <input className="fi" value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder={notConfigured ? 'e.g. Cave de la Tour' : 'Search or type venue name…'}
          />
          {loading && (
            <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', fontSize:10, color:'var(--fg-faint)', fontFamily:'var(--mono)' }}>
              searching…
            </span>
          )}
        </div>

        {open && results.length > 0 && (
          <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:100, background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,0.4)', overflow:'hidden', marginTop:4 }}>
            {results.map(p => (
              <button key={p.id} type="button" onClick={() => selectPlace(p)}
                style={{ display:'flex', alignItems:'flex-start', gap:10, width:'100%', padding:'10px 12px', background:'none', border:'none', borderBottom:'1px solid var(--border)', cursor:'pointer', textAlign:'left' }}
                onMouseEnter={e => (e.currentTarget.style.background='var(--bg3)')}
                onMouseLeave={e => (e.currentTarget.style.background='none')}
              >
                <span style={{ fontSize:18, flexShrink:0, lineHeight:1.3 }}>{venueIcon(p.types)}</span>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--fg)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.address}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* City + Country — auto-filled on selection, still editable */}
      <div style={{ display:'flex', gap:8 }}>
        <div className="field" style={{ flex:1 }}>
          <div className="fl">city</div>
          <input className="fi" value={value.city||''} onChange={e => onChange({...value, city:e.target.value})} placeholder="Zurich" />
        </div>
        <div className="field" style={{ maxWidth:80 }}>
          <div className="fl">country</div>
          <input className="fi" value={value.country||''} onChange={e => onChange({...value, country:e.target.value.toUpperCase().slice(0,2)})} placeholder="CH" maxLength={2} />
        </div>
      </div>

      <button type="button" className="btn-s" onClick={useGeo} disabled={locating} style={{ marginTop:2 }}>
        {locating ? 'locating…' : loading ? 'finding nearby venues…' : '📍 find nearby venues'}
      </button>

      {notConfigured && (
        <p style={{ fontSize:10, color:'var(--fg-faint)', marginTop:6, fontFamily:'var(--mono)', letterSpacing:'0.04em' }}>
          Add GOOGLE_PLACES_API_KEY to enable venue search
        </p>
      )}
    </div>
  )
}
