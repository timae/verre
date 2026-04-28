'use client'
import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useSession } from './SessionShell'

interface Props { onClose: () => void; onLeave: () => void }

export function SessionModal({ onClose, onLeave }: Props) {
  const { code, displayName, isHost, sessionMeta, refresh } = useSession()
  const [participants, setParticipants] = useState<string[]>([])
  const [coHosts, setCoHosts] = useState<string[]>([])
  const [newName, setNewName] = useState(sessionMeta?.name || '')
  const [displayNameInput, setDisplayNameInput] = useState(displayName)
  const [copied, setCopied] = useState(false)
  const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}/?join=${code}` : ''

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

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  async function toggleCoHost(targetUser: string) {
    const isCoHost = coHosts.includes(targetUser)
    const res = await fetch(`/api/session/${code}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName, targetUser, action: isCoHost ? 'remove-cohost' : 'add-cohost' }),
    })
    if (res.ok) {
      const { meta } = await res.json()
      setCoHosts(meta.coHosts || [])
    }
  }

  async function renameSession() {
    if (!newName.trim()) return
    await fetch(`/api/session/${code}/name`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), userName: displayName }),
    })
    refresh()
  }

  return (
    <div style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{width:'100%',maxWidth:600,maxHeight:'90vh',overflowY:'auto',background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />
        <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:18}}>You</div>

        {/* Account status */}
        <div style={{padding:'10px 12px',background:'rgba(143,184,122,0.07)',border:'1px solid rgba(143,184,122,0.18)',borderRadius:10,marginBottom:16,display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:'var(--accent2)',flexShrink:0}} />
          <div style={{fontSize:12,color:'var(--fg-dim)'}}>
            Tasting as <strong style={{color:'var(--fg)'}}>{displayName}</strong>
            {' · '}Session <strong style={{color:'var(--accent)',letterSpacing:'0.12em'}}>{code}</strong>
            {sessionMeta?.name && <span style={{color:'var(--fg-dim)'}}>{' · '}{sessionMeta.name}</span>}
          </div>
        </div>

        {/* Participants */}
        {participants.length > 0 && (
          <div style={{marginBottom:16}}>
            <div className="fl">// participants</div>
            <div style={{display:'flex',flexDirection:'column',gap:4}}>
              {participants.map(u => {
                const isThisHost = u === sessionMeta?.host
                const isCoHost = coHosts.includes(u)
                const isMe = u === displayName
                return (
                  <div key={u} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'1px solid var(--bg3)'}}>
                    <span style={{color:'var(--accent2)',fontSize:10}}>→</span>
                    <span style={{flex:1,fontSize:12}}>{u}</span>
                    {isThisHost && <span style={{fontSize:9,color:'var(--accent)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(200,150,60,0.3)',padding:'1px 5px',borderRadius:2}}>host</span>}
                    {isCoHost && !isThisHost && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(143,184,122,0.3)',padding:'1px 5px',borderRadius:2}}>co-host</span>}
                    {isHost && !isThisHost && !isMe && (
                      <button className="btn-s" style={{fontSize:9,padding:'3px 8px'}} onClick={() => toggleCoHost(u)}>
                        {isCoHost ? 'remove role' : 'make co-host'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Session rename (host only) */}
        {isHost && (
          <div style={{marginBottom:16}}>
            <div className="field">
              <div className="fl">session name</div>
              <input className="fi" value={newName} onChange={e => setNewName(e.target.value)} maxLength={80} placeholder="e.g. Friday Bordeaux tasting" />
            </div>
            <button className="btn-s" onClick={renameSession}>save name</button>
          </div>
        )}

        {/* Invite */}
        <div style={{marginBottom:16}}>
          <div className="fl">invite link</div>
          <div style={{fontSize:11,color:'var(--fg-dim)',marginBottom:8,lineHeight:1.6}}>Share the link or scan the QR code to join this session.</div>
          <div style={{fontSize:11,color:'var(--accent)',wordBreak:'break-all',marginBottom:8,fontFamily:'var(--mono)'}}>{inviteUrl}</div>
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button className="btn-s" onClick={copyInvite}>{copied ? 'copied ✓' : 'copy link'}</button>
            {typeof navigator !== 'undefined' && 'share' in navigator && (
              <button className="btn-s" onClick={() => navigator.share?.({ url: inviteUrl, title: `Join tasting ${code}` })}>share</button>
            )}
          </div>
          {inviteUrl && (
            <div style={{display:'flex',justifyContent:'center',padding:'12px',background:'var(--bg3)',borderRadius:8}}>
              <QRCodeSVG value={inviteUrl} size={160} bgColor="transparent" fgColor="var(--fg)" />
            </div>
          )}
        </div>

        <div style={{fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.08em',marginBottom:12}}>Sessions auto-expire after 48 hours of inactivity.</div>

        <button className="btn-p" onClick={onClose} style={{marginBottom:6}}>→ close</button>
        <button className="btn-g" onClick={onLeave}>leave session</button>
      </div>
    </div>
  )
}
