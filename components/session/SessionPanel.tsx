'use client'
import { useState, useEffect } from 'react'
import { Modal } from '@/components/ui/Modal'
import { useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useSession } from './SessionShell'
import { useSession as useAuthSession } from 'next-auth/react'
import { LifespanSelector } from './LifespanSelector'
import { RoleBadge } from './RoleBadge'
import { sessionFetch } from '@/lib/sessionFetch'
import { formatCode } from '@verre/core'
import { joinPath } from '@/lib/sessionCode'
import { ProfilePreviewInline } from '@/components/profile/ProfilePreviewInline'
import { ParticipantActionsMenu } from './ParticipantActionsMenu'
import { BanPreviewModal } from './BanPreviewModal'
import { BannedUsersSection } from './BannedUsersSection'
import { SetRoleButton } from './SetRoleButton'
import { renderWithLinks } from '@/lib/renderWithLinks'

interface Props { onClose: () => void; onLeave: () => void }

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
  const { code, myId, isHost, sessionMeta } = useSession()
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

  // Read from the polled SessionShell meta — joins/leaves and role
  // changes appear without a manual reload.
  const participants = sessionMeta?.participants ?? []
  const coHostIds = sessionMeta?.coHostIds ?? []
  const providerIds = sessionMeta?.providerIds ?? []
  const [expandedId,    setExpandedId]    = useState<string | null>(null)
  const [copied,        setCopied]        = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [saveError,     setSaveError]     = useState('')
  // Which required settings fields failed the last save (red border), cleared
  // per-field as the user edits.
  const [badFields, setBadFields] = useState({ name: false, start: false })
  const [showParticipants, setShowParticipants] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [deleteError,   setDeleteError]   = useState('')
  // Modal state for the host's kick/ban flow. `null` = closed.
  const [removeTarget, setRemoveTarget] = useState<
    { identityId: string; displayName: string; mode: 'kick' | 'ban' } | null
  >(null)

  // isStrictHost: true only for the actual session host, NOT co-hosts.
  // Used for actions that we restrict to the host alone (currently:
  // delete-session). isHost from context is true for cohosts too.
  const isStrictHost = !!(myId && (
    (sessionMeta?.hostIdentityId && myId === sessionMeta.hostIdentityId) ||
    (sessionMeta?.hostUserId && myId === `u:${sessionMeta.hostUserId}`)
  ))
  // Mirror the server's softened check (see app/api/session/[code]/route.ts).
  // The literal '[deleted]' is also used by lib/accountDelete on the server;
  // duplicated here to avoid pulling server-only deps into the client bundle.
  const hostIsGone = !!(sessionMeta && !sessionMeta.hostIdentityId && !sessionMeta.hostUserId && sessionMeta.host === '[deleted]')
  const isCohost = !!(myId && sessionMeta?.coHostIds?.includes(myId))
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

  // Clear one field's flag as it's fixed, dropping the summary once none remain.
  function fixField(key: 'name' | 'start') {
    setBadFields(prev => {
      const next = { ...prev, [key]: false }
      if (!next.name && !next.start) setSaveError('')
      return next
    })
  }

  async function saveSettings() {
    setSaveError('')
    // Name + start date are required and can't be cleared (Simon, 2026-07-06 —
    // the same invariant the server enforces; also applies to old dateless
    // moments, which must gain a start date before their next save). Collect all
    // required misses first (red border on each, one summary), then the To-pair
    // consistency checks (a lone date/time).
    const bad = { name: !name.trim(), start: !dateFromDate || !dateFromTime }
    setBadFields(bad)
    const missCount = Number(bad.name) + Number(bad.start)
    if (missCount > 0) {
      setSaveError(
        missCount > 1 ? 'Please fill in the highlighted fields.'
        : bad.name ? 'Please name your moment.'
        : 'Please set a start date and time.',
      )
      return
    }
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
      // One aggregate query — invalidation already refetches it; a
      // refresh() on top would double-fetch.
      await queryClient.invalidateQueries({ queryKey: ['session-state', code] })
      onClose()
    } else { const d = await res.json(); setSaveError(d.error || 'save failed') }
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  // Invalidate the cached session state after a role change so the
  // actor sees the new role instantly. Other participants pick it up
  // on their own next poll tick.
  function onRoleChanged() {
    queryClient.invalidateQueries({ queryKey: ['session-state', code] })
  }

  const ttlLabel = formatTTL(m?.ttlSeconds ?? -1, m?.lifespan)

  return (
    <Modal onClose={onClose} maxWidth={600} maxHeight="90vh">
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
                    cursor:'pointer',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:11,
                    letterSpacing:'0.1em',textTransform:'uppercase',marginBottom: showParticipants ? 12 : 0}}
                >
                  <span>participants ({participants.length})</span>
                  <span style={{fontSize:11,color:'var(--fg-faint)'}}>{showParticipants ? '▾' : '▸'}</span>
                </button>
                {showParticipants && (
                  <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:12}}>
                    {(() => {
                      // Hoist the meta cast + derived block sets once so the
                      // per-row render below reads from stable refs.
                      const meta = sessionMeta as { hostUserId?: number | null; hostIdentityId?: string; viewerBlocksOut?: string[]; viewerBlocksIn?: string[] } | null
                      const blocksOut = new Set(meta?.viewerBlocksOut ?? [])
                      const blocksIn = new Set(meta?.viewerBlocksIn ?? [])
                      const isHostId = (id: string) =>
                        !!(meta?.hostIdentityId && id === meta.hostIdentityId)
                        || !!(meta?.hostUserId && id === `u:${meta.hostUserId}`)
                      // Sort: me → host → co-hosts → everyone else, so a
                      // participant scanning the list finds themselves first,
                      // then the people running the session. Server join order
                      // breaks ties within each tier.
                      const tier = (id: string) => {
                        if (id === myId) return 0
                        if (isHostId(id)) return 1
                        if (coHostIds.includes(id)) return 2
                        return 3
                      }
                      // Block-pair render matrix (no row is hidden):
                      //   - Third-party: shown normally.
                      //   - Blocker viewing blocked (any tier): "[blocked]
                      //     {name}" + role badge, clickable to unblock.
                      //   - Blocked viewing blocker (any tier): anon-style
                      //     — plain name + role badge, no bold, no link.
                      //   - Mutual block: anon-style, no "[blocked]" prefix.
                      //     Treated as anon so neither side surfaces "this
                      //     identifiable person is here." Unblock reachable
                      //     from the other user's /u/<id> page or settings.
                      const sorted = [...participants].sort((a, b) => tier(a.id) - tier(b.id))
                      return sorted.map(p => {
                        const isThisHost = isHostId(p.id)
                        const isCo = coHostIds.includes(p.id)
                        const isProv = providerIds.includes(p.id)
                        const isMe = p.id === myId
                        // Resolve the target's current role for the SetRoleButton
                        // picker, which omits the current role from the option
                        // list (no point offering "set to what they already are").
                        const targetCurrentRole: 'taster' | 'co_host' | 'provider' =
                          isCo ? 'co_host' : isProv ? 'provider' : 'taster'
                        // Block-pair render flags.
                        //   blockedByMe: viewer is the blocker side.
                        //   blockingMe:  viewer is the blocked side.
                        const blockedByMe = blocksOut.has(p.id)
                        const blockingMe = blocksIn.has(p.id)
                        // `u:<userId>` = logged-in account, `a:<uuid>` = anon.
                        const isLoggedIn = p.id.startsWith('u:')
                        // Clickable when the row isn't anon-styled AND is a
                        // logged-in account. blockingMe covers both one-way
                        // blocked and mutual block (anon-style in both cases).
                        // blockedByMe alone (one-way blocker) stays clickable
                        // so the blocker can open the inline preview + unblock.
                        const isClickable = !blockingMe && isLoggedIn
                        // Defensive: if a mid-session block flip drops a row
                        // out of clickability, collapse any open preview on
                        // that row so it doesn't lock open.
                        const isExpanded = isClickable && expandedId === p.id
                        const profileUserId = isLoggedIn ? Number(p.id.slice(2)) : null
                        const onRowClick = () => {
                          if (!isClickable) return
                          setExpandedId(isExpanded ? null : p.id)
                        }
                        // Bold only on a normal logged-in row — drop bold on
                        // any block-pair render (anon-style on the blocked
                        // side, [blocked]+plain on the blocker side, anon on
                        // mutual).
                        const isBold = isLoggedIn && !blockedByMe && !blockingMe
                        // [blocked] prefix only on one-way blocker-side. On
                        // mutual, the row is anon — no prefix, no signal.
                        const showBlockedPrefix = blockedByMe && !blockingMe
                        return (
                          <div key={p.id}>
                            <div style={{
                              display:'flex',alignItems:'center',gap:8,
                              padding:'6px 8px',
                              borderBottom: isExpanded ? 'none' : '1px solid var(--bg3)',
                              borderRadius: isMe ? 6 : 0,
                              background: isMe ? 'rgba(200,150,60,0.08)' : 'transparent',
                              cursor: isClickable ? 'pointer' : 'default',
                            }} onClick={onRowClick}>
                              <span style={{color:'var(--accent2)',fontSize:10}}>→</span>
                              <span style={{flex:1,fontSize:11,fontWeight: isBold || showBlockedPrefix ? 700 : 400}}>
                                {showBlockedPrefix && <span style={{color:'rgba(184,64,64,0.95)',fontWeight:400,marginRight:4,fontFamily:'var(--mono)'}}>[blocked]</span>}
                                {p.displayName}
                                {isMe && <span style={{color:'var(--fg-dim)',fontWeight:400,marginLeft:6}}>· you</span>}
                              </span>
                              <RoleBadge role={isThisHost ? 'host' : isCo ? 'co-host' : isProv ? 'provider' : null} />
                              {/* Set/Change role — host or cohost can promote/
                                  demote per the locked transition rule. Strict-
                                  host sees Co-host as an option; cohost-only
                                  viewers see Taster + Provider. The picker
                                  itself enforces both ends of the rule. */}
                              {isHost && !isThisHost && !isMe && !(isCo && !isStrictHost) && (
                                <SetRoleButton
                                  code={code}
                                  identityId={p.id}
                                  currentRole={targetCurrentRole}
                                  viewerIsStrictHost={isStrictHost}
                                  onChanged={onRoleChanged}
                                />
                              )}
                              {/* Kick/Ban menu. Cohosts can target regular
                                  participants only; strict-host can target
                                  cohosts too. Hide the menu when a cohost is
                                  looking at another cohost — the server
                                  would 403 anyway and the empty menu is
                                  confusing. */}
                              {isHost && !isThisHost && !isMe && (
                                <ParticipantActionsMenu
                                  identityId={p.id}
                                  displayName={p.displayName}
                                  targetIsCohost={isCo}
                                  viewerIsStrictHost={isStrictHost}
                                  onPickKick={(id, name) => setRemoveTarget({ identityId: id, displayName: name, mode: 'kick' })}
                                  onPickBan={(id, name) => setRemoveTarget({ identityId: id, displayName: name, mode: 'ban' })}
                                />
                              )}
                            </div>
                            {isExpanded && profileUserId !== null && (
                              <ProfilePreviewInline
                                userId={profileUserId}
                                isSelf={isMe}
                                viewerLoggedIn={!!myId && myId.startsWith('u:')}
                                myId={myId && myId.startsWith('u:') ? Number(myId.slice(2)) : null}
                                indent={16}
                              />
                            )}
                          </div>
                        )
                      })
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Banned users (host + cohost only). Only rendered when at
                least one ban exists — banCount rides on the polled
                session GET so cross-host bans propagate without a page
                reload. Visual style mirrors the PARTICIPANTS row
                above. */}
            {isHost && (sessionMeta?.banCount ?? 0) > 0 && (
              <BannedUsersSection code={code} count={sessionMeta?.banCount ?? 0} />
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
              <input className={`fi${badFields.name ? ' error' : ''}`} aria-invalid={badFields.name || undefined} value={name} onChange={e => { setName(e.target.value); if (badFields.name && e.target.value.trim()) fixField('name') }} maxLength={80} placeholder="e.g. Friday Bordeaux tasting" />
            </div>
            <div className="field">
              <div className="fl">address</div>
              <input className="fi" value={address} onChange={e => setAddress(e.target.value)} maxLength={255} placeholder="e.g. Restaurant du Palais, Paris" />
            </div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <div className="field" style={{flex:'1 1 220px',minWidth:0}}>
                <div className="fl">from</div>
                <div style={{display:'flex',gap:4}}>
                  <input className={`fi${badFields.start ? ' error' : ''}`} aria-invalid={badFields.start || undefined} type="date" value={dateFromDate} onChange={e => { setDateFromDate(e.target.value); if (badFields.start && e.target.value && dateFromTime) fixField('start') }} style={{flex:1,minWidth:0}} />
                  <input className={`fi${badFields.start ? ' error' : ''}`} aria-invalid={badFields.start || undefined} type="time" value={dateFromTime} onChange={e => { setDateFromTime(e.target.value); if (badFields.start && e.target.value && dateFromDate) fixField('start') }} style={{width:96,flexShrink:0}} />
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

            {saveError && <p style={{color:'var(--danger)',fontSize:11,marginBottom:8}}>{saveError}</p>}
            <button
              onClick={saveSettings} disabled={saving}
              style={{width:'100%',padding:'12px 0',borderRadius:8,border:'1px solid var(--accent2)',background:'rgba(143,184,122,0.15)',color:'var(--accent2)',fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer',marginTop:4}}
            >{saving ? 'saving…' : '→ save settings'}</button>

            {/* Danger zone — strict host only (not co-hosts). */}
            {canDeleteSession && (
              <div style={{marginTop:24,padding:14,border:'1px solid rgba(224,112,112,0.3)',background:'rgba(224,112,112,0.04)',borderRadius:8}}>
                <div style={{fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--danger)',marginBottom:6,fontFamily:'var(--mono)'}}>danger zone</div>
                <div style={{fontSize:11,color:'var(--fg-dim)',marginBottom:10,lineHeight:1.5}}>
                  Close this session for good. Your tasters keep their ratings, notes and tasting history on their own profiles, and anyone who bookmarked a wine still has it under Saved — the session itself just shows as deleted. This cannot be undone.
                </div>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  style={{width:'100%',padding:'10px 0',borderRadius:6,border:'1px solid rgba(224,112,112,0.4)',background:'rgba(224,112,112,0.08)',color:'var(--danger)',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
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
            <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:10,color:'var(--danger)'}}>Delete this session?</div>
            <div style={{fontSize:12,color:'var(--fg)',lineHeight:1.6,marginBottom:14}}>
              The session closes for good. Your tasters keep their ratings, notes and tasting history on their own profiles, and anyone who bookmarked a wine still has it under Saved — the session itself just shows as deleted.
              <div style={{marginTop:8,color:'var(--danger)',fontSize:11,fontWeight:700}}>This cannot be undone.</div>
            </div>
            {deleteError && <p style={{color:'var(--danger)',fontSize:11,marginBottom:8}}>{deleteError}</p>}
            <div style={{display:'flex',gap:8}}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                style={{flex:1,padding:'10px 0',borderRadius:6,border:'1px solid var(--border2)',background:'var(--bg3)',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
              >cancel</button>
              <button
                onClick={deleteSession}
                disabled={deleting}
                style={{flex:1,padding:'10px 0',borderRadius:6,border:'1px solid rgba(224,112,112,0.5)',background:'rgba(224,112,112,0.15)',color:'var(--danger)',fontFamily:'var(--mono)',fontSize:12,fontWeight:700,letterSpacing:'0.06em',cursor:'pointer'}}
              >{deleting ? 'deleting…' : 'delete'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Kick/Ban preview modal. Renders when the host picks an action
          from a participant row's ⋯ menu. Closes after a successful
          ban/kick; we invalidate session-state so the participants list
          re-fetches with the now-absent target. */}
      {removeTarget && (
        <BanPreviewModal
          code={code}
          identityId={removeTarget.identityId}
          displayName={removeTarget.displayName}
          mode={removeTarget.mode}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={() => {
            setRemoveTarget(null)
            // One aggregate query carries meta + wines + ratings — the
            // invalidation refetches all three sections.
            queryClient.invalidateQueries({ queryKey: ['session-state', code] })
          }}
        />
      )}
    </Modal>
  )
}
