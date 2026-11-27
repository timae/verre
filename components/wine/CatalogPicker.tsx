'use client'
import { useEffect, useId, useRef, useState } from 'react'
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
// 🔒 The NV control (ruled 2026-07-26, phase B): a checkbox beside each year
// input. Ticking it clears and disables the input, and the add flow gets a
// real `year: null` (the NV row), never a string the server has to parse.
// A typed "NV" is still read as NV (habit), the hint says 20XX.
// 🔒 The match is only ever a suggestion: nothing is linked until the person
// picks (never the top hit automatically).

export type PickedLabel = { name: string; producer: string; year: string; colour: string | null; sparkling: boolean }
// `abv` on a pick: an alcohol typed for a listed year that has none (0.2.0
// build 2: a report, shown to everyone on that year; signed in only).
export type CatalogChoice =
  | { kind: 'pick'; productId: string; vintageId: string | null; abv?: number; label: PickedLabel }
  | { kind: 'create'; body: Record<string, unknown>; label: PickedLabel }

type Producer = { id: string; name: string; country: string | null; region: string | null }
type Product = { id: string; name: string; colour: string | null; sparkling: boolean; region: string | null; producerId: string; producerName: string }
type Vintage = { id: string; year: number | null; abv?: number | null }
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
type YearRead = { ok: true; year?: number | null } | { ok: false }
function parseYear(raw: string): YearRead {
  const v = normalizeVintageText(raw.trim())
  if (!raw.trim()) return { ok: true }
  if (v === 'NV') return { ok: true, year: null }
  if (/^\d{4}$/.test(v)) return { ok: true, year: Number(v) }
  return { ok: false }
}
// A year input with its NV box: ticked, the year is the NV row.
const yearOf = (nvTicked: boolean, text: string): YearRead => nvTicked ? { ok: true as const, year: null } : parseYear(text)

// The NV box beside a year input, with the (i) that says what NV means (the
// IntensityHelp pattern: outside click or Escape closes it; so does focus
// moving on past it, or a later Escape would be the popover's, not the sheet's).
function NvToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const noteId = useId()
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={ref} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }} style={{position:'relative',display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
      <label style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:12,fontWeight:600,color:'var(--fg)',cursor:'pointer'}}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{accentColor:'var(--accent)',margin:0}} />
        NV
      </label>
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="What does NV mean?" aria-expanded={open} aria-describedby={open ? noteId : undefined}
        style={{width:16,height:16,borderRadius:'50%',border:'1px solid var(--fg-dim)',background:'transparent',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:10,fontWeight:700,lineHeight:1,padding:0,cursor:'pointer',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>i</button>
      {open && (
        <div id={noteId} role="note" style={{position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:20,background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,padding:10,boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:200,maxWidth:260,fontSize:11,color:'var(--fg)',lineHeight:1.4}}>
          Non-vintage: a release without a year.
        </div>
      )}
    </div>
  )
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
  const [nv, setNv] = useState(prefill?.year === 'NV')
  const [yearText, setYearText] = useState(prefill?.year === 'NV' ? '' : prefill?.year ?? '')
  const [abvText, setAbvText] = useState('')
  const [grapes, setGrapes] = useState(prefill?.grape ?? '')
  const [region, setRegion] = useState('')
  const [country, setCountry] = useState('')
  const [addYear, setAddYear] = useState('')
  const [addNv, setAddNv] = useState(false)
  const [reportText, setReportText] = useState('')
  const [notice, setNotice] = useState('')
  const [more, setMore] = useState(false)
  const seq = useRef(0)

  // A new label scan restarts the search from its producer.
  useEffect(() => {
    if (!prefill) return
    setProducer(null); setProduct(null); setCreating(false); onChange(null)
    setProducerQ(prefill.producer ?? ''); setWineQ(prefill.name ?? ''); setGrapes(prefill.grape ?? '')
    setNv(prefill.year === 'NV'); setYearText(prefill.year === 'NV' ? '' : prefill.year ?? '')
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
      // `similar=1`: the forgiving list when every word finds nothing (a label
      // scan's text often holds words the stored name lacks; step 7b ruling).
      const r = await ask<Producer>(`kind=producer&similar=1&q=${encodeURIComponent(producerQ.trim())}`)
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
    const y = yearOf(nv, yearText)
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
  }, [creating, producer, wineQ, kind, nv, yearText, abvText, grapes, region, country])

  function reset() {
    setProducer(null); setProduct(null); setVintages(null); setCreating(false); setAddYear(''); setAddNv(false); setReportText(''); setNotice(''); onChange(null)
  }
  const pickYear = (p: Product, v: Vintage | null) => { setReportText(''); setNotice(''); onChange({
    kind: 'pick', productId: p.id, vintageId: v?.id ?? null,
    label: { name: p.name, producer: p.producerName, year: v ? (v.year === null ? 'NV' : String(v.year)) : '', colour: p.colour, sparkling: p.sparkling },
  }) }
  // The alcohol of a listed year without one (signed in): '' = none, else a
  // number 0 to 25 put on the pick; a bad value is named and not sent.
  function setReport(pickValue: Extract<CatalogChoice, { kind: 'pick' }>, t: string) {
    setReportText(t)
    const n = t.trim() === '' ? undefined : Number(t.replace(',', '.'))
    const ok = n === undefined || (Number.isFinite(n) && n >= 0 && n <= 25)
    setNotice(ok ? '' : 'Alcohol must be between 0 and 25 %.')
    const rest: Extract<CatalogChoice, { kind: 'pick' }> = { kind: 'pick', productId: pickValue.productId, vintageId: pickValue.vintageId, label: pickValue.label }
    onChange(ok && n !== undefined ? { ...rest, abv: Math.round(n * 100) / 100 } : rest)
  }
  // "add a year" offers NV only once the years are in and none is NV (that
  // one is a chip); a tick from before they arrived counts for nothing.
  const nvAddable = vintages !== null && !vintages.some(v => v.year === null)
  const addNvOn = addNv && nvAddable
  function addMissingYear(p: Product) {
    const y = yearOf(addNvOn, addYear)
    if (!y.ok || !('year' in y)) { setNotice(nvAddable ? 'Type a four-digit year, or tick NV.' : 'Type a four-digit year.'); return }
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
    const picked = value.kind === 'pick' && value.vintageId ? vintages?.find(v => v.id === value.vintageId) : undefined
    const canReport = canCreate && value.kind === 'pick' && !!picked && (picked.abv === null || picked.abv === undefined)
    return (
      <>
        <ChosenWine label="wine *" name={value.label.name} year={value.label.year} producer={value.label.producer}
          note={value.kind === 'create' ? 'new' : undefined} action="change" onAction={reset} />
        {canReport && value.kind === 'pick' && (
          <div className="field" style={{maxWidth:110}}>
            <div className="fl">alcohol %</div>
            <input className="fi" value={reportText} onChange={e => setReport(value, e.target.value)} inputMode="decimal" placeholder="13.5" />
          </div>
        )}
        {notice && <p style={{fontSize:11,color:'var(--danger)',margin:'0 0 10px'}}>{notice}</p>}
      </>
    )
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
                <button key={p.id} type="button" style={rowStyle} onClick={() => { setProduct(p); setAddNv(false) }}>
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
            <div className="field" style={{maxWidth:170}}>
              <div className="fl">year</div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <input className="fi" value={yearText} disabled={nv} onChange={e => setYearText(e.target.value)} maxLength={4} placeholder="20XX" style={{width:70,opacity:nv ? 0.5 : 1}} />
                <NvToggle checked={nv} onChange={v => { setNv(v); if (v) setYearText('') }} />
              </div>
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
          {!yearOf(nv, yearText).ok && <p style={{fontSize:10,color:'var(--danger)',margin:'0 0 8px'}}>Type a four-digit year, or tick NV.</p>}
        </div>
      )}

      {/* 3 — the year of a picked wine */}
      {product && (
        <div className="field">
          <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:13,fontWeight:700}}>{product.name}</span>
            <button type="button" className="btn-s" onClick={() => { setProduct(null); setAddNv(false); onChange(null) }}>change</button>
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
              <div className="field" style={{maxWidth:170,marginBottom:0}}>
                <div className="fl">add a year</div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <input className="fi" value={addYear} disabled={addNvOn} onChange={e => setAddYear(e.target.value)} maxLength={4} placeholder="20XX" style={{width:70,opacity:addNvOn ? 0.5 : 1}} />
                  {nvAddable && (
                    <NvToggle checked={addNvOn} onChange={v => { setAddNv(v); if (v) setAddYear('') }} />
                  )}
                </div>
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
