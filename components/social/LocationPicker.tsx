'use client'
import { useState } from 'react'

interface LocationData { venueName?: string; city?: string; country?: string; lat?: number; lng?: number }
interface Props { value: LocationData; onChange: (v: LocationData) => void }

export function LocationPicker({ value, onChange }: Props) {
  const [locating, setLocating] = useState(false)

  async function useGeo() {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
        const d = await res.json()
        onChange({
          ...value, lat, lng,
          city: d.address?.city || d.address?.town || d.address?.village || '',
          country: d.address?.country_code?.toUpperCase() || '',
        })
      } catch {
        onChange({ ...value, lat, lng })
      }
      setLocating(false)
    }, () => setLocating(false))
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
      <div className="fl" style={{ marginBottom: 8 }}>location <span style={{ opacity: .5, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
      <div className="field">
        <div className="fl">venue</div>
        <input className="fi" value={value.venueName || ''} onChange={e => onChange({ ...value, venueName: e.target.value })} placeholder="Cave de la Tour, Bar XY…" />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <div className="fl">city</div>
          <input className="fi" value={value.city || ''} onChange={e => onChange({ ...value, city: e.target.value })} placeholder="Zurich" />
        </div>
        <div className="field" style={{ maxWidth: 80 }}>
          <div className="fl">country</div>
          <input className="fi" value={value.country || ''} onChange={e => onChange({ ...value, country: e.target.value.toUpperCase().slice(0, 2) })} placeholder="CH" maxLength={2} />
        </div>
      </div>
      <button type="button" className="btn-s" onClick={useGeo} disabled={locating} style={{ marginTop: 4 }}>
        {locating ? 'locating…' : '📍 use my location'}
      </button>
    </div>
  )
}
