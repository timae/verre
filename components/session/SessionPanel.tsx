'use client'
import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useSession } from './SessionShell'
import { useSession as useAuthSession } from 'next-auth/react'
import { LifespanSelector } from './LifespanSelector'

interface Props { onClose: () => void; onLeave: () => void }

function renderWithLinks(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>{part}</a>
      : part
  )
}

function formatDate(dt: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

function formatTTL(seconds: number, lifespan?: string): string {
  if (lifespan === 'unlimited') return '∞ unlimited'
  if (seconds <= 0) return 'expired'
  const days  = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins  = Math.floor((seconds % 3600) / 60)
  if (days  > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

function toLocalDatetimeInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const HIDE_OPTIONS = [
  { value: 0,  label: 'at start time' },
  { value: 15, label: '15 min before' },
  { value: 30, label: '30 min before' },
  { value: 60, label: '1 hour before' },
]

export function SessionPanel({ onClose, onLeave }: Props) {
  const { code, displayName, isHost, sessionMeta, refresh } = useSession()
  const { data: authSession } = useAuthSession()
  const isPro = !!(authSession?.user as { pro?: boolean })?.pro

  const m = sessionMeta as typeof sessionMeta & {
    address?: string; dateFrom?: string | null; dateTo?: string | null
    description?: string; link?: string; blind?: boolean; lifespan?: string
    coHosts?: string[]; hideLineup?: boolean; hideLineupMinutesBefore?: number
    ttlSeconds?: number
  }

  const [tab, setTab] = useState<'overview' | 'settings'>('overview')

  const [name,                    setName]                    = useState(m?.name                    || '')
  const [address,                 setAddress]                 = useState(m?.address                 || '')
  const [dateFrom,                setDateFrom]                = useState(() => toLocalDatetimeInput(m?.dateFrom || ''))
  const [dateTo,                  setDateTo]                  = useState(() => toLocalDatetimeInput(m?.dateTo   || ''))
  const [description,             setDescription]             = useState(m?.description             || '')
  const [link,                    setLink]                    = useState(m?.link                    || '')
  const [blind,                   setBlind]                   = useState(!!m?.blind)
  const [lifespan,                setLifespan]                = useState(m?.lifespan                || '48h')
  const [hideLineup,              setHideLineup]              = useState(!!m?.hideLineup)
  const [hideLineupMinutesBefore, setHideLineupMinutesBefore] = useState(m?.hideLineupMinutesBefore ?? 0)

  const [participants,  setParticipants]  = useState<string[]>([])
  const [coHosts,       setCoHosts]       = useState<string[]>([])
  const [copied,        setCopied]        = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [saveError,     setSaveError]     = useState('')
  const [showParticipants, setShowParticipants] = useState(false)

  const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}/join/${code}` : ''
  const mapsUrl = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : ''

  useEffect(() => {
    fetch(`/api/session/${code}`)
      .then(r => r.json())
      .then(d => { setParticipants(d.users || []); setCoHosts(d.coHosts || []) })
      .catch(() => {})
  }, [code])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function saveSettings() {
    setSaveError('')
    if (dateFrom && !dateFrom.includes('T')) {
      setSaveError('Please add a time to the date (e.g. 19:00).')
      return
    }
    if (dateTo && !dateTo.includes('T')) {
      setSaveError('Please add a time to the end date.')
      return
    }
    setSaving(true)
    const dateFromISO = dateFrom ? new Date(dateFrom).toISOString() : ''
    const dateToISO   = dateTo   ? new Date(dateTo).toISOString()   : ''
    const res = await fetch(`/api/session/${code}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName, name, address, dateFrom: dateFromISO, dateTo: dateToISO, description, link, blind, lifespan, hideLineup, hideLineupMinutesBefore }),
    })
    setSaving(false)
    if (res.ok) { refresh() }
    else { const d = await res.json(); setSaveError(d.error || 'save failed') }
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  async function toggleCoHost(targetUser: string) {
    const isCo = coHosts.includes(targetUser)
    const res = await fetch(`/api/session/${code}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName, targetUser, action: isCo ? 'remove-cohost' : 'add-cohost' }),
    })
    if (res.ok) { const { meta } = await res.json(); setCoHosts(meta.coHosts || []) }
  }

  const ttlLabel = formatTTL(m?.ttlSeconds ?? -1, m?.lifespan)

  return (
    <div
      style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{width:'100%',maxWidth:600,maxHeight:'90vh',overflowY:'auto',background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
          <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em'}}>{m?.name || code}</div>
          <button className="btn-s" onClick={onClose} style={{fontSize:9}}>close</button>
        </div>
        <div style={{fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.08em',marginBottom:16}}>{ttlLabel}</div>

        {/* Tab bar — hosts only */}
        {isHost && (
          <div style={{display:'flex',gap:1,marginBottom:16,background:'var(--bg3)',borderRadius:8,padding:3}}>
            {(['overview', 'settings'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                style={{flex:1,padding:'6px 0',borderRadius:6,border:'none',
                  background: tab === t ? 'var(--bg2)' : 'transparent',
                  color: tab === t ? 'var(--fg)' : 'var(--fg-dim)',
                  fontSize:11,fontFamily:'var(--mono)',letterSpacing:'0.06em',cursor:'pointer'}}>
                {t}
              </button>
            ))}
          </div>
        )}

        {/* Overview tab (always shown for non-hosts, or when tab === 'overview') */}
        {(!isHost || tab === 'overview') && (
          <div>
            {/* Read-only metadata for non-hosts */}
            {!isHost && (m?.description || m?.dateFrom || m?.address || m?.link) && (
              <div style={{marginBottom:16,display:'flex',flexDirection:'column',gap:6}}>
                {m.description && (
                  <div style={{fontSize:12,color:'var(--fg)',lineHeight:1.5,whiteSpace:'pre-wrap'}}>{renderWithLinks(m.description)}</div>
                )}
                {m.dateFrom && (
                  <div style={{fontSize:11,color:'var(--fg-dim)',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
                    <span>🕐</span>
                    <span>{formatDate(m.dateFrom)}</span>
                    {m.dateTo && <><span>→</span><span>{formatDate(m.dateTo)}</span></>}
                  </div>
                )}
                {m.address && (
                  <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                    style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--accent)',textDecoration:'none'}}>
                    <span>📍</span>{m.address}
                  </a>
                )}
                {m.link && (
                  <a href={m.link} target="_blank" rel="noopener noreferrer"
                    style={{fontSize:11,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:6}}>
                    <span>🔗</span>{m.link}
                  </a>
                )}
              </div>
            )}

            {/* Share link */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:8,fontFamily:'var(--mono)'}}>invite link</div>
              <div style={{fontSize:11,color:'var(--accent)',wordBreak:'break-all',marginBottom:8,fontFamily:'var(--mono)'}}>{inviteUrl}</div>
              <div style={{display:'flex',gap:8,marginBottom:12}}>
                <button className="btn-s" onClick={copyInvite}>{copied ? 'copied ✓' : 'copy link'}</button>
                {typeof navigator !== 'undefined' && 'share' in navigator && (
                  <button className="btn-s" onClick={() => navigator.share?.({ url: inviteUrl, title: `Join tasting ${code}` })}>share</button>
                )}
              </div>
              {inviteUrl && (
                <div style={{display:'flex',justifyContent:'center',padding:12,background:'var(--bg3)',borderRadius:8}}>
                  <QRCodeSVG value={inviteUrl} size={160} bgColor="transparent" fgColor="var(--fg)" />
                </div>
              )}
            </div>

            {/* Participants (collapsible, collapsed by default) */}
            {participants.length > 0 && (
              <div>
                <button
                  onClick={() => setShowParticipants(!showParticipants)}
                  style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',
                    padding:'10px 0',background:'none',border:'none',borderTop:'1px solid var(--border)',
                    cursor:'pointer',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:9,
                    letterSpacing:'0.1em',textTransform:'uppercase',marginBottom: showParticipants ? 12 : 0}}
                >
                  <span>participants ({participants.length})</span>
                  <span style={{fontSize:11,color:'var(--fg-faint)'}}>{showParticipants ? '▾' : '▸'}</span>
                </button>
                {showParticipants && (
                  <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:12}}>
                    {participants.map(u => {
                      const isThisHost = u === sessionMeta?.host
                      const isCo = coHosts.includes(u)
                      const isMe = u === displayName
                      return (
                        <div key={u} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'1px solid var(--bg3)'}}>
                          <span style={{color:'var(--accent2)',fontSize:10}}>→</span>
                          <span style={{flex:1,fontSize:12}}>{u}</span>
                          {isThisHost && <span style={{fontSize:9,color:'var(--accent)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(200,150,60,0.3)',padding:'1px 5px',borderRadius:2}}>host</span>}
                          {isCo && !isThisHost && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(143,184,122,0.3)',padding:'1px 5px',borderRadius:2}}>co-host</span>}
                          {isHost && !isThisHost && !isMe && (
                            <button className="btn-s" style={{fontSize:9,padding:'3px 8px'}} onClick={() => toggleCoHost(u)}>
                              {isCo ? 'remove role' : 'make co-host'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Settings tab (hosts only) */}
        {isHost && tab === 'settings' && (
          <div>
            <div className="field">
              <div className="fl">session name</div>
              <input className="fi" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="e.g. Friday Bordeaux tasting" />
            </div>
            <div className="field">
              <div className="fl">address</div>
              <input className="fi" value={address} onChange={e => setAddress(e.target.value)} maxLength={255} placeholder="e.g. Restaurant du Palais, Paris" />
            </div>
            <div style={{display:'flex',gap:8}}>
              <div className="field" style={{flex:1}}>
                <div className="fl">from</div>
                <input className="fi" type="datetime-local" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </div>
              <div className="field" style={{flex:1}}>
                <div className="fl">to</div>
                <input className="fi" type="datetime-local" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <div className="fl">description</div>
              <textarea className="fi" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000}
                placeholder="A few words about this tasting…" rows={3}
                style={{resize:'vertical',fontFamily:'var(--mono)',fontSize:12}} />
            </div>
            <div className="field">
              <div className="fl">link</div>
              <input className="fi" value={link} onChange={e => setLink(e.target.value)} maxLength={512} placeholder="https://…" type="url" />
            </div>

            {/* Hide lineup toggle — only when dateFrom is set */}
            {dateFrom && (
              <div style={{marginBottom:10}}>
                <div
                  onClick={() => setHideLineup(!hideLineup)}
                  style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:8,
                    border:`1px solid ${hideLineup ? 'rgba(100,140,220,0.4)' : 'var(--border)'}`,
                    background: hideLineup ? 'rgba(100,140,220,0.08)' : 'var(--bg3)',cursor:'pointer',marginBottom: hideLineup ? 8 : 0}}
                >
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color: hideLineup ? '#8aabff' : 'var(--fg)'}}>🔒 Hide lineup before tasting</div>
                    <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>Participants see a locked screen until just before the session starts</div>
                  </div>
                  <div style={{width:36,height:20,borderRadius:10,background: hideLineup ? '#8aabff' : 'var(--bg4)',
                    border:'1px solid var(--border2)',position:'relative',transition:'background .2s',flexShrink:0}}>
                    <div style={{width:14,height:14,borderRadius:'50%',background:'#fff',position:'absolute',top:2,left: hideLineup ? 18 : 2,transition:'left .2s'}} />
                  </div>
                </div>
                {hideLineup && (
                  <div style={{display:'flex',gap:6,flexWrap:'wrap',paddingLeft:2}}>
                    {HIDE_OPTIONS.map(o => (
                      <button key={o.value} type="button"
                        onClick={() => setHideLineupMinutesBefore(o.value)}
                        style={{padding:'5px 10px',borderRadius:6,border: hideLineupMinutesBefore === o.value ? '1px solid #8aabff' : '1px solid var(--border)',
                          background: hideLineupMinutesBefore === o.value ? 'rgba(100,140,220,0.1)' : 'var(--bg3)',
                          color: hideLineupMinutesBefore === o.value ? '#8aabff' : 'var(--fg-dim)',
                          fontSize:10,fontFamily:'var(--mono)',cursor:'pointer'}}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Blind tasting toggle */}
            <div
              onClick={() => setBlind(!blind)}
              style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:8,
                border:`1px solid ${blind ? 'rgba(200,150,60,0.4)' : 'var(--border)'}`,
                background: blind ? 'rgba(200,150,60,0.08)' : 'var(--bg3)',cursor:'pointer',marginBottom:10}}
            >
              <div>
                <div style={{fontSize:11,fontWeight:700,color: blind ? 'var(--accent)' : 'var(--fg)'}}>🙈 Blind tasting</div>
                <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>Wine identities hidden — you reveal them one by one</div>
              </div>
              <div style={{width:36,height:20,borderRadius:10,background: blind ? 'var(--accent)' : 'var(--bg4)',
                border:'1px solid var(--border2)',position:'relative',transition:'background .2s',flexShrink:0}}>
                <div style={{width:14,height:14,borderRadius:'50%',background:'#fff',position:'absolute',top:2,left: blind ? 18 : 2,transition:'left .2s'}} />
              </div>
            </div>

            <LifespanSelector value={lifespan} onChange={setLifespan} isPro={isPro} />

            {saveError && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{saveError}</p>}
            <button
              onClick={saveSettings} disabled={saving}
              style={{width:'100%',padding:'12px 0',borderRadius:8,border:'1px solid var(--accent2)',background:'rgba(143,184,122,0.15)',color:'var(--accent2)',fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer',marginTop:4}}
            >{saving ? 'saving…' : '→ save settings'}</button>
          </div>
        )}

        <button className="btn-p" onClick={onClose} style={{marginBottom:6,marginTop:16}}>→ close</button>
        <button className="btn-g" onClick={onLeave}>leave session</button>
      </div>
    </div>
  )
}
