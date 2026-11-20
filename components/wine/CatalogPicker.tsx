'use client'
import { useEffect, useRef, useState } from 'react'
import { normalizeVintageText } from '@verre/core'
import { CountrySelect } from '@/components/ui/CountrySelect'
import { ChosenWine } from '@/components/wine/ChosenWine'

// The plain catalogue picker (catalogue model change step 4; ruled 2026-11-18:
// "a plain working picker, search, pick or create, inside today's modals").
// Producer first, then the wine under it, then its year:
//   • pick an existing producer → its wines (or add one under it: add-flow branch 3)
//   • pick a wine → its years (or year unknown, or add a missing year: branch 2)
//   • nothing fits → a new producer and wine (branch 4)
// Creating needs an account (the server refuses a guest); a guest picks only.
// The type picker is red / white / rosé / sparkling; alcohol-free is not a
// choice: it is derived from the optional abv (≤ 0.5 %, spec § 0.2).
// 🔒 The match is only ever a suggestion: nothing is linked until the person
// picks (never the top hit automatically).

export type PickedLabel = { name: string; producer: string; year: string; colour: string | null; sparkling: boolean }
export type CatalogChoice =
  | { kind: 'pick'; productId: string; vintageId: string | null; label: PickedLabel }
  | { kind: 'create'; body: Record<string, unknown>; label: PickedLabel }

type Producer = { id: string; name: string; country: string | null; region: string | null }
type Product = { id: string; name: string; colour: string | null; sparkling: boolean; region: string | null; producerId: string; producerName: string }
type Vintage = { id: string; year: number | null }
export type ScanPrefill = { producer?: string; name?: string; grape?: string; year?: string; type?: string }

const KINDS = [
  { k: 'red', l: 'Red', ico: '🍷' },
  { k: 'white', l: 'White', ico: '🥂' },
  { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'spark', l: 'Sparkling', ico: '🍾' },
] as const
const kindBody = (k: string) => (k === 'spark' ? { sparkling: true } : { colour: k })
const kindLabel = (k: string): { colour: string | null; sparkling: boolean } => (k === 'spark' ? { colour: null, sparkling: true } : { colour: k || null, sparkling: false })

interface Props {
  // Builds the search URL for a query string (the moment's own route inside a
  // moment, the global one for a check-in) and fetches it.
  search: (qs: string) => Promise<Response>
  canCreate: boolean
  value: CatalogChoice | null
  onChange: (c: CatalogChoice | null) => void
  prefill?: ScanPrefill | null
}

// Year text → the add-flow's `year`: '' = unknown (absent), NV → null, a year.
function parseYear(raw: string): { ok: true; year?: number | null } | { ok: false } {
  const v = normalizeVintageText(raw.trim())
  if (!raw.trim()) return { ok: true }
  if (v === 'NV') return { ok: true, year: null }
  if (/^\d{4}$/.test(v)) return { ok: true, year: Number(v) }
  return { ok: false }
}

export function CatalogPicker({ search, canCreate, value, onChange, prefill }: Props) {
  const [producerQ, setProducerQ] = useState(prefill?.producer ?? '')
  const [producers, setProducers] = useState<Producer[]>([])
  const [producer, setProducer] = useState<Producer | { id: null; name: string } | null>(null)
  const [wineQ, setWineQ] = useState(prefill?.name ?? '')
  const [products, setProducts] = useState<Product[]>([])
  const [product, setProduct] = useState<Product | null>(null)
  const [vintages, setVintages] = useState<Vintage[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [kind, setKind] = useState(prefill?.type && KINDS.some(t => t.k === prefill.type) ? prefill.type : '')
  const [yearText, setYearText] = useState(prefill?.year ?? '')
  const [abvText, setAbvText] = useState('')
  const [grapes, setGrapes] = useState(prefill?.grape ?? '')
  const [region, setRegion] = useState('')
  const [country, setCountry] = useState('')
  const [addYear, setAddYear] = useState('')
  const [notice, setNotice] = useState('')
  const [more, setMore] = useState(false)
  const seq = useRef(0)

  // A new label scan restarts the search from its producer.
  useEffect(() => {
    if (!prefill) return
    setProducer(null); setProduct(null); setCreating(false); onChange(null)
    setProducerQ(prefill.producer ?? ''); setWineQ(prefill.name ?? ''); setYearText(prefill.year ?? ''); setGrapes(prefill.grape ?? '')
    if (prefill.type && KINDS.some(t => t.k === prefill.type)) setKind(prefill.type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  async function ask<T>(qs: string, onMore?: (more: boolean) => void): Promise<T[] | null> {
    const res = await search(qs).catch(() => null)
    if (!res) { setNotice('Search failed. Try again.'); return null }
    if (res.status === 404) { setNotice('Adding bottles is unavailable right now.'); return null }
    if (res.status === 429) { setNotice('Too many searches. Wait a moment.'); return null }
    if (!res.ok) { setNotice('Search failed. Try again.'); return null }
    setNotice('')
    const j = (await res.json().catch(() => null)) as { results?: T[]; more?: boolean } | null
    onMore?.(!!j?.more)
    return j?.results ?? []
  }

  // Debounced searches (one request per pause in typing; a late answer to an
  // older query is dropped).
  useEffect(() => {
    if (producer || producerQ.trim().length < 3) { setProducers([]); return }
    const n = ++seq.current
    const t = setTimeout(async () => {
      const r = await ask<Producer>(`kind=producer&q=${encodeURIComponent(producerQ.trim())}`)
      if (r && n === seq.current) setProducers(r)
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [producerQ, producer])
  // Under 3 characters the server lists that producer's wines A to Z, so a
  // short name is found by picking it (review r1), and nothing typed yet shows
  // the list straight away.
  useEffect(() => {
    if (!producer?.id || product || creating) { setProducts([]); return }
    const n = ++seq.current
    const t = setTimeout(async () => {
      const r = await ask<Product>(`kind=product&producerId=${encodeURIComponent(producer.id!)}&q=${encodeURIComponent(wineQ.trim())}`, m => { if (n === seq.current) setMore(m) })
      if (r && n === seq.current) setProducts(r)
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wineQ, producer, product, creating])
  useEffect(() => {
    if (!product) { setVintages(null); return }
    let live = true
    ask<Vintage>(`kind=vintages&productId=${encodeURIComponent(product.id)}`).then(r => { if (live) setVintages(r) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product])

  // The draft of a NEW wine, kept as the choice while it is valid.
  useEffect(() => {
    if (!creating || !producer) return
    const y = parseYear(yearText)
    const abv = abvText.trim() === '' ? undefined : Number(abvText.replace(',', '.'))
    const valid = !!wineQ.trim() && !!kind && y.ok && (abv === undefined || (Number.isFinite(abv) && abv >= 0 && abv <= 25))
    if (!valid) { if (value) onChange(null); return }
    const body: Record<string, unknown> = {
      ...(producer.id ? { producerId: producer.id } : { producer: { name: producer.name.trim() } }),
      product: {
        name: wineQ.trim(), ...kindBody(kind),
        ...(grapes.trim() ? { grapes: grapes.split(',').map(g => g.trim()).filter(Boolean) } : {}),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(country ? { country } : {}),
      },
      ...(y.ok && 'year' in y ? { year: y.year } : {}),
      ...(abv !== undefined ? { abv } : {}),
    }
    onChange({ kind: 'create', body, label: { name: wineQ.trim(), producer: producer.name.trim(), year: y.ok && 'year' in y ? (y.year === null ? 'NV' : String(y.year)) : '', ...kindLabel(kind) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, producer, wineQ, kind, yearText, abvText, grapes, region, country])

  function reset() {
    setProducer(null); setProduct(null); setVintages(null); setCreating(false); setAddYear(''); onChange(null)
  }
  const pickYear = (p: Product, v: Vintage | null) => onChange({
    kind: 'pick', productId: p.id, vintageId: v?.id ?? null,
    label: { name: p.name, producer: p.producerName, year: v ? (v.year === null ? 'NV' : String(v.year)) : '', colour: p.colour, sparkling: p.sparkling },
  })
  function addMissingYear(p: Product) {
    const y = parseYear(addYear)
    if (!y.ok || !('year' in y)) { setNotice('Type a four-digit year, or NV.'); return }
    const abv = abvText.trim() === '' ? undefined : Number(abvText.replace(',', '.'))
    if (abv !== undefined && !(Number.isFinite(abv) && abv >= 0 && abv <= 25)) { setNotice('Alcohol must be between 0 and 25 %.'); return }
    setNotice('')
    onChange({
      kind: 'create', body: { productId: p.id, year: y.year, ...(abv !== undefined ? { abv } : {}) },
      label: { name: p.name, producer: p.producerName, year: y.year === null ? 'NV' : String(y.year), colour: p.colour, sparkling: p.sparkling },
    })
  }

  // A choice made: its summary, and a way back.
  if (value && !creating) {
    return <ChosenWine label="wine *" name={value.label.name} year={value.label.year} producer={value.label.producer}
      note={value.kind === 'create' ? 'new' : undefined} action="change" onAction={reset} />
  }

  const listStyle: React.CSSProperties = { display:'flex',flexDirection:'column',gap:4,marginTop:6 }
  const rowStyle: React.CSSProperties = { textAlign:'left',padding:'6px 8px',border:'1px solid var(--border)',borderRadius:6,background:'var(--bg)',color:'var(--fg)',cursor:'pointer',fontSize:12 }

  return (
    <div>
      {/* 1 — the producer */}
      <div className="field">
        <div className="fl">producer *</div>
        {producer ? (
          <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'space-between'}}>
            <span style={{fontSize:13,fontWeight:700}}>{producer.name}{producer.id ? '' : ' · new'}</span>
            <button type="button" className="btn-s" onClick={reset}>change</button>
          </div>
        ) : (
          <>
            <input className="fi" value={producerQ} onChange={e => setProducerQ(e.target.value)} placeholder="Domaine…" />
            {producerQ.trim().length >= 3 && (
              <div style={listStyle}>
                {producers.map(p => (
                  <button key={p.id} type="button" style={rowStyle} onClick={() => { setProducer(p); setNotice('') }}>
                    {p.name}<span style={{color:'var(--fg-faint)'}}>{[p.region, p.country].filter(Boolean).length ? ` · ${[p.region, p.country].filter(Boolean).join(', ')}` : ''}</span>
                  </button>
                ))}
                {canCreate && (
                  <button type="button" style={{...rowStyle,color:'var(--accent)'}} onClick={() => { setProducer({ id: null, name: producerQ.trim() }); setCreating(true) }}>
                    + new producer: {producerQ.trim()}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 2 — the wine under it */}
      {producer && !product && (
        <div className="field">
          <div className="fl">wine *</div>
          <input className="fi" value={wineQ} onChange={e => setWineQ(e.target.value)} placeholder="Cuvée…" />
          {producer.id && !creating && (
            <div style={listStyle}>
              {more && wineQ.trim().length < 3 && (
                <div style={{fontSize:10,color:'var(--fg-faint)'}}>The first 20 of this producer&rsquo;s wines: type to narrow the list.</div>
              )}
              {products.map(p => (
                <button key={p.id} type="button" style={rowStyle} onClick={() => setProduct(p)}>
                  {p.name}<span style={{color:'var(--fg-faint)'}}>{p.sparkling ? ' · sparkling' : p.colour ? ` · ${p.colour === 'rose' ? 'rosé' : p.colour}` : ''}</span>
                </button>
              ))}
              {canCreate && wineQ.trim() && (
                <button type="button" style={{...rowStyle,color:'var(--accent)'}} onClick={() => setCreating(true)}>
                  + new wine under {producer.name}: {wineQ.trim()}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 2b — a new wine's facts (producer + name + type required) */}
      {creating && producer && (
        <div style={{padding:'10px 12px 4px',border:'1px solid var(--border)',borderRadius:8,marginBottom:12}}>
          <div className="field">
            <div className="fl">type *</div>
            <div className="chips">
              {KINDS.map(t => (
                <div key={t.k} className="chip" data-sel={kind === t.k ? t.k : undefined} onClick={() => setKind(t.k)}>
                  <span>{t.ico}</span>{t.l}
                </div>
              ))}
            </div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <div className="field" style={{maxWidth:110}}>
              <div className="fl">year</div>
              <input className="fi" value={yearText} onChange={e => setYearText(e.target.value)} maxLength={4} placeholder="20XX or NV" />
            </div>
            <div className="field" style={{maxWidth:110}}>
              <div className="fl">alcohol %</div>
              <input className="fi" value={abvText} onChange={e => setAbvText(e.target.value)} inputMode="decimal" placeholder="13.5" />
            </div>
          </div>
          <div className="field">
            <div className="fl">grapes</div>
            <input className="fi" value={grapes} onChange={e => setGrapes(e.target.value)} placeholder="Pinot Noir, Chardonnay" />
          </div>
          <div style={{display:'flex',gap:8}}>
            <div className="field" style={{flex:1,minWidth:0}}>
              <div className="fl">region</div>
              <input className="fi" value={region} maxLength={255} onChange={e => setRegion(e.target.value)} placeholder="Burgundy, Wachau…" />
            </div>
            <div className="field" style={{flex:1,minWidth:0}}>
              <div className="fl">country</div>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
          </div>
          {!parseYear(yearText).ok && <p style={{fontSize:10,color:'var(--danger)',margin:'0 0 8px'}}>Type a four-digit year, or NV.</p>}
        </div>
      )}

      {/* 3 — the year of a picked wine */}
      {product && (
        <div className="field">
          <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:13,fontWeight:700}}>{product.name}</span>
            <button type="button" className="btn-s" onClick={() => { setProduct(null); onChange(null) }}>change</button>
          </div>
          <div className="fl">year</div>
          <div className="chips">
            {(vintages ?? []).map(v => (
              <div key={v.id} className="chip" onClick={() => pickYear(product, v)}>{v.year === null ? 'NV' : v.year}</div>
            ))}
            <div className="chip" onClick={() => pickYear(product, null)}>year unknown</div>
          </div>
          {canCreate && (
            <div style={{display:'flex',gap:8,alignItems:'flex-end',marginTop:8}}>
              <div className="field" style={{maxWidth:110,marginBottom:0}}>
                <div className="fl">add a year</div>
                <input className="fi" value={addYear} onChange={e => setAddYear(e.target.value)} maxLength={4} placeholder="20XX or NV" />
              </div>
              <div className="field" style={{maxWidth:110,marginBottom:0}}>
                <div className="fl">alcohol %</div>
                <input className="fi" value={abvText} onChange={e => setAbvText(e.target.value)} inputMode="decimal" placeholder="13.5" />
              </div>
              <button type="button" className="btn-s" onClick={() => addMissingYear(product)}>add</button>
            </div>
          )}
        </div>
      )}

      {!canCreate && <p style={{fontSize:10,color:'var(--fg-faint)',margin:'0 0 10px'}}>Sign in to add a wine that isn&rsquo;t in the catalogue yet.</p>}
      {notice && <p style={{fontSize:11,color:'var(--danger)',margin:'0 0 10px'}}>{notice}</p>}
    </div>
  )
}
