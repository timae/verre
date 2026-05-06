'use client'
import { useState, useEffect } from 'react'
import { Modal } from '@/components/ui/Modal'
import { useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useSession } from './SessionShell'
import { useSession as useAuthSession } from 'next-auth/react'
import { LifespanSelector } from './LifespanSelector'
import { sessionFetch } from '@/lib/sessionFetch'
import { formatCode, joinPath } from '@/lib/sessionCode'

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

function splitLocalDatetime(iso: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

const HIDE_OPTIONS = [
  { value: 0,  label: 'at start time' },
  { value: 15, label: '15 min before' },
  { value: 30, label: '30 min before' },
  { value: 60, label: '1 hour before' },
]

export function SessionPanel({ onClose, onLeave }: Props) {
  const { code, myId, isHost, sessionMeta, refresh } = useSession()
  const { data: authSession } = useAuthSession()
  const queryClient = useQueryClient()
  const isPro = !!(authSession?.user as { pro?: boolean })?.pro

  const m = sessionMeta as typeof sessionMeta & {
    address?: string; dateFrom?: string | null; dateTo?: string | null
    description?: string; link?: string; blind?: boolean; lifespan?: string
    hideLineup?: boolean; hideLineupMinutesBefore?: number
    ttlSeconds?: number
  }

  const [tab, setTab] = useState<'overview' | 'settings'>('overview')

  const [name,                    setName]                    = useState(m?.name                    || '')
  const [address,                 setAddress]                 = useState(m?.address                 || '')
  const initFrom = splitLocalDatetime(m?.dateFrom || '')
  const initTo   = splitLocalDatetime(m?.dateTo   || '')
  const [dateFromDate, setDateFromDate] = useState(initFrom.date)
  const [dateFromTime, setDateFromTime] = useState(initFrom.time)
  const [dateToDate,   setDateToDate]   = useState(initTo.date)
  const [dateToTime,   setDateToTime]   = useState(initTo.time)
  const [description,             setDescription]             = useState(m?.description             || '')
  const [link,                    setLink]                    = useState(m?.link                    || '')
  const [blind,                   setBlind]                   = useState(!!m?.blind)
  const [lifespan,                setLifespan]                = useState(m?.lifespan                || '48h')
  const [hideLineup,              setHideLineup]              = useState(!!m?.hideLineup)
  const [hideLineupMinutesBefore, setHideLineupMinutesBefore] = useState(m?.hideLineupMinutesBefore ?? 0)

  type Participant = { id: string; displayName: string }
  const [participants,  setParticipants]  = useState<Participant[]>([])
  const [coHostIds,     setCoHostIds]     = useState<string[]>([])
  const [copied,        setCopied]        = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [saveError,     setSaveError]     = useState('')
  const [showParticipants, setShowParticipants] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [deleteError,   setDeleteError]   = useState('')

  // isStrictHost: true only for the actual session host, NOT co-hosts.
  // Used for actions that we restrict to the host alone (currently:
  // delete-session). isHost from context is true for cohosts too.
  const sm = sessionMeta as typeof sessionMeta & { hostIdentityId?: string; coHostIds?: string[] }
  const isStrictHost = !!(myId && (
    (sm?.hostIdentityId && myId === sm.hostIdentityId) ||
    (sm?.hostUserId && myId === `u:${sm.hostUserId}`)
  ))
  // Mirror the server's softened check (see app/api/session/[code]/route.ts).
  // The literal '[deleted]' is also used by lib/accountDelete on the server;
  // duplicated here to avoid pulling server-only deps into the client bundle.
  const hostIsGone = !!(sm && !sm.hostIdentityId && !sm.hostUserId && sm.host === '[deleted]')
  const isCohost = !!(myId && sm?.coHostIds?.includes(myId))
  const canDeleteSession = isStrictHost || (hostIsGone && isCohost)

  async function deleteSession() {
    setDeleteError(''); setDeleting(true)
    const res = await sessionFetch(code, `/api/session/${code}`, { method: 'DELETE' })
    setDeleting(false)
    if (res.ok) {
      // Clear any local cached session state so the next visit doesn't
      // try to use a stale token / name pointing at a session that no
      // longer exists. Then leave to the lobby.
      try {
        // code is already canonical via SessionShell's normalizeCode.
        localStorage.removeItem(`vr_anon_${code}`)
        localStorage.removeItem(`vr_name_${code}`)
        localStorage.removeItem(`vr_id_${code}`)
      } catch {}
      window.location.href = '/'
      return
    }
    const data = await res.json().catch(() => ({}))
    setDeleteError(data.error || 'delete failed')
  }

  const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}${joinPath(code)}` : ''
  const mapsUrl = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : ''

  useEffect(() => {
    sessionFetch(code, `/api/session/${code}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        setParticipants(d.participants || [])
        setCoHostIds(d.coHostIds || [])
      })
      .catch(() => {})
  }, [code])

  // While the delete-confirm is open, intercept Escape in the capture phase
  // so it closes the confirm (and only the confirm), not the parent Modal
  // underneath. Without this, Modal's keydown listener would fire first
  // and dismiss the whole panel on Escape — surprising and destructive.
  useEffect(() => {
    if (!showDeleteConfirm) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setShowDeleteConfirm(false)
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [showDeleteConfirm])

  async function saveSettings() {
    setSaveError('')
    if (dateFromDate && !dateFromTime) { setSaveError('Please add a time to the start date.'); return }
    if (dateFromTime && !dateFromDate) { setSaveError('Please add a date to the start time.'); return }
    if (dateToDate   && !dateToTime)   { setSaveError('Please add a time to the end date.');   return }
    if (dateToTime   && !dateToDate)   { setSaveError('Please add a date to the end time.');   return }
    setSaving(true)
    const dateFromISO = dateFromDate && dateFromTime ? new Date(`${dateFromDate}T${dateFromTime}`).toISOString() : ''
    const dateToISO   = dateToDate   && dateToTime   ? new Date(`${dateToDate}T${dateToTime}`).toISOString()     : ''
    const res = await sessionFetch(code, `/api/session/${code}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address, dateFrom: dateFromISO, dateTo: dateToISO, description, link, blind, lifespan, hideLineup, hideLineupMinutesBefore }),
    })
    setSaving(false)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['session-meta', code] })
      refresh()
    } else { const d = await res.json(); setSaveError(d.error || 'save failed') }
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  async function toggleCoHost(targetId: string) {
    const isCo = coHostIds.includes(targetId)
    const res = await sessionFetch(code, `/api/session/${code}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId, action: isCo ? 'remove-cohost' : 'add-cohost' }),
    })
    if (res.ok) {
      const { meta } = await res.json()
      setCoHostIds(meta.coHostIds || [])
    }
  }

  const ttlLabel = formatTTL(m?.ttlSeconds ?? -1, m?.lifespan)

  return (
    <Modal onClose={onClose} maxWidth={600} maxHeight="90vh">
      <div className="sheet-bar" />

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
          <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em'}}>{m?.name || formatCode(code)}</div>
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
                    {participants.map(p => {
                      const meta = sessionMeta as { hostUserId?: number | null; hostIdentityId?: string } | null
                      const isThisHost = !!(meta?.hostIdentityId && p.id === meta.hostIdentityId)
                        || !!(meta?.hostUserId && p.id === `u:${meta.hostUserId}`)
                      const isCo = coHostIds.includes(p.id)
                      const isMe = p.id === myId
                      return (
                        <div key={p.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'1px solid var(--bg3)'}}>
                          <span style={{color:'var(--accent2)',fontSize:10}}>→</span>
                          <span style={{flex:1,fontSize:12}}>{p.displayName}</span>
                          {isThisHost && <span style={{fontSize:9,color:'var(--accent)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(200,150,60,0.3)',padding:'1px 5px',borderRadius:2}}>host</span>}
                          {isCo && !isThisHost && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(143,184,122,0.3)',padding:'1px 5px',borderRadius:2}}>co-host</span>}
                          {isHost && !isThisHost && !isMe && (
                            <button className="btn-s" style={{fontSize:9,padding:'3px 8px'}} onClick={() => toggleCoHost(p.id)}>
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

            {/* Share link */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:8,fontFamily:'var(--mono)',marginTop: participants.length > 0 ? 12 : 0}}>invite link</div>
              <div style={{fontSize:11,color:'var(--accent)',wordBreak:'break-all',marginBottom:8,fontFamily:'var(--mono)'}}>{inviteUrl}</div>
              <div style={{display:'flex',gap:8,marginBottom:12}}>
                <button className="btn-s" onClick={copyInvite}>{copied ? 'copied ✓' : 'copy link'}</button>
                {typeof navigator !== 'undefined' && 'share' in navigator && (
                  <button className="btn-s" onClick={() => navigator.share?.({ url: inviteUrl, title: `Join tasting ${formatCode(code)}` })}>share</button>
                )}
              </div>
              {inviteUrl && (
                <div style={{display:'flex',justifyContent:'center',padding:12,background:'var(--bg3)',borderRadius:8}}>
                  <QRCodeSVG value={inviteUrl} size={160} bgColor="transparent" fgColor="var(--fg)" />
                </div>
              )}
            </div>
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
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <div className="field" style={{flex:'1 1 220px',minWidth:0}}>
                <div className="fl">from</div>
                <div style={{display:'flex',gap:4}}>
                  <input className="fi" type="date" value={dateFromDate} onChange={e => setDateFromDate(e.target.value)} style={{flex:1,minWidth:0}} />
                  <input className="fi" type="time" value={dateFromTime} onChange={e => setDateFromTime(e.target.value)} style={{width:96,flexShrink:0}} />
                </div>
              </div>
              <div className="field" style={{flex:'1 1 220px',minWidth:0}}>
                <div className="fl">to</div>
                <div style={{display:'flex',gap:4}}>
                  <input className="fi" type="date" value={dateToDate} onChange={e => setDateToDate(e.target.value)} style={{flex:1,minWidth:0}} />
                  <input className="fi" type="time" value={dateToTime} onChange={e => setDateToTime(e.target.value)} style={{width:96,flexShrink:0}} />
                </div>
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

            {/* Hide lineup toggle — only when full from-datetime is set */}
            {dateFromDate && dateFromTime && (
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

            {/* Blind tasting toggle. Enabling requires pro; non-pro/anon
                hosts can still disable it (matches server-side check). */}
            <div
              onClick={() => {
                // Block enabling when not pro. Allow disabling for anyone.
                if (!blind && !isPro) return
                setBlind(!blind)
              }}
              style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:8,
                border:`1px solid ${blind ? 'rgba(200,150,60,0.4)' : 'var(--border)'}`,
                background: blind ? 'rgba(200,150,60,0.08)' : 'var(--bg3)',
                cursor: (!blind && !isPro) ? 'default' : 'pointer',
                opacity: (!blind && !isPro) ? 0.5 : 1,
                marginBottom:10}}
              title={(!blind && !isPro) ? 'Requires a Pro account' : undefined}
            >
              <div>
                <div style={{fontSize:11,fontWeight:700,color: blind ? 'var(--accent)' : 'var(--fg)',display:'flex',alignItems:'center',gap:6}}>
                  🙈 Blind tasting
                  {!isPro && !blind && <span style={{fontSize:9,background:'var(--bg)',border:'1px solid rgba(200,150,60,0.4)',borderRadius:3,padding:'1px 5px',letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)'}}>pro</span>}
                </div>
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

            {/* Danger zone — strict host only (not co-hosts). */}
            {canDeleteSession && (
              <div style={{marginTop:24,padding:14,border:'1px solid rgba(224,112,112,0.3)',background:'rgba(224,112,112,0.04)',borderRadius:8}}>
                <div style={{fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'#e07070',marginBottom:6,fontFamily:'var(--mono)'}}>danger zone</div>
                <div style={{fontSize:11,color:'var(--fg-dim)',marginBottom:10,lineHeight:1.5}}>
                  Delete this session permanently. Wines stay saved for participants who bookmarked them; everyone else&apos;s ratings, notes and Hall of Fame entries from this session are removed. This cannot be undone.
                </div>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  style={{width:'100%',padding:'10px 0',borderRadius:6,border:'1px solid rgba(224,112,112,0.4)',background:'rgba(224,112,112,0.08)',color:'#e07070',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
                >⌫ delete this session</button>
              </div>
            )}
          </div>
        )}

        <button className="btn-p" onClick={onClose} style={{marginBottom:6,marginTop:16}}>→ close</button>
        <button className="btn-g" onClick={onLeave}>leave session</button>

      {/* Delete-session confirmation modal. Stops propagation so a click
          inside the modal doesn't close the SessionPanel underneath. */}
      {showDeleteConfirm && (
        <div
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setShowDeleteConfirm(false) }}
          style={{position:'fixed',inset:0,zIndex:60,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.7)',backdropFilter:'blur(6px)',padding:16}}
        >
          <div style={{maxWidth:420,width:'100%',background:'var(--bg2)',borderRadius:16,padding:20,border:'1px solid rgba(224,112,112,0.3)'}}>
            <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:10,color:'#e07070'}}>Delete this session?</div>
            <div style={{fontSize:12,color:'var(--fg)',lineHeight:1.6,marginBottom:14}}>
              This permanently removes the session and its wine list. Bookmarked wines stay saved with their ratings, notes and flavour wheel intact for those who bookmarked them. Every other rating and Hall of Fame entry from this session is removed.
              <div style={{marginTop:8,color:'#e07070',fontSize:11,fontWeight:700}}>This cannot be undone.</div>
            </div>
            {deleteError && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{deleteError}</p>}
            <div style={{display:'flex',gap:8}}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                style={{flex:1,padding:'10px 0',borderRadius:6,border:'1px solid var(--border2)',background:'var(--bg3)',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
              >cancel</button>
              <button
                onClick={deleteSession}
                disabled={deleting}
                style={{flex:1,padding:'10px 0',borderRadius:6,border:'1px solid rgba(224,112,112,0.5)',background:'rgba(224,112,112,0.15)',color:'#e07070',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
              >{deleting ? 'deleting…' : 'delete'}</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
