'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { sessionFetch } from '@/lib/sessionFetch'
import { stripDisambiguationEmoji } from '@verre/core'
import { RoleBadge } from './RoleBadge'

interface Props {
  // Current display name as stored in the identities map.
  displayName: string
  // Session code for the rename API call.
  code: string
  // Caller's session role for the badge in the identity block. Anon
  // users can be hosts (anon-host flow) or providers; default is the
  // null (taster) state which renders no badge.
  role: 'host' | 'co-host' | 'provider' | null
  // Called with the SERVER-resolved name (possibly emoji-suffixed) so
  // the shell can update its local storedName + localStorage, which
  // drives the header and this dropdown on re-render.
  onRenamed: (newName: string) => void
}

// Header dropdown for anonymous session participants. Mirrors UserMenu's
// visual shape (name + green dot + chevron) but with anon-specific
// content: a one-shot rename for the per-session display name, plus
// sign-in / sign-up CTAs.
//
// Rename API: PATCH /api/session/<code>/me/name with { name }.
// Returns { name: <possibly-suffixed-with-emoji> } — server-side
// disambiguation may append an emoji if the typed name collides with
// another participant's current name.
export function SessionAnonMenu({ displayName, code, role, onRenamed }: Props) {
  // The bare name without any auto-added disambiguation emoji. Edit
  // input shows this so users only see what they originally typed.
  // Renaming back to a bare name that's still in collision will get a
  // fresh emoji on save (possibly a different one).
  const bareName = stripDisambiguationEmoji(displayName)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(bareName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Brief post-submit confirmation flash ('changed' or 'unchanged'),
  // shown in the identity block for ~1.5s after submit, then cleared.
  const [flash, setFlash] = useState<'changed' | 'unchanged' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setEditing(false)
        setError(null)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Focus the input when entering edit mode.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // Re-seed draft from the bare displayName if the upstream name
  // changes (e.g. another tab renamed) and we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(bareName)
  }, [bareName, editing])

  // Auto-clear the flash after 1.5s so the dropdown returns to its
  // normal resting state.
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1500)
    return () => clearTimeout(t)
  }, [flash])

  async function submitRename() {
    const next = draft.trim()
    setError(null)
    // No-change shortcut: if the typed name equals the current bare
    // name, skip the network call and show "unchanged" feedback.
    if (!next || next === bareName) {
      setEditing(false)
      setFlash('unchanged')
      return
    }
    setSaving(true)
    try {
      const res = await sessionFetch(code, `/api/session/${code}/me/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'rename failed' }))
        setError(typeof data.error === 'string' ? data.error : 'rename failed')
        return
      }
      // Server returns the (possibly emoji-suffixed) resolved name.
      // Pass it back so the shell updates storedName + localStorage —
      // both the header label and this dropdown re-render from it.
      const data = await res.json().catch(() => ({}))
      const resolved = typeof data.name === 'string' ? data.name : next
      const actuallyChanged = resolved !== displayName
      onRenamed(resolved)
      // After onRenamed propagates the new displayName, the bareName
      // memo re-derives and the re-seed effect updates draft. Exit
      // edit mode immediately so the user sees the flash in the normal
      // identity block (not behind the edit input).
      setEditing(false)
      setFlash(actuallyChanged ? 'changed' : 'unchanged')
    } catch {
      setError('rename failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={ref} style={{position:'relative'}}>
      <button
        onClick={() => setOpen(!open)}
        style={{display:'flex',alignItems:'center',gap:6,fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.06em',color:'var(--fg-dim)',border:'1px solid var(--border)',background:'var(--bg2)',padding:'5px 10px',borderRadius:3,cursor:'pointer'}}
      >
        <div style={{width:6,height:6,borderRadius:'50%',background:'var(--accent2)',flexShrink:0}} />
        {displayName || 'anon'}
        <span style={{fontSize:8,color:'var(--fg-faint)',marginLeft:2}}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',width:220,background:'var(--bg2)',border:'1px solid var(--border2)',borderRadius:10,overflow:'hidden',boxShadow:'0 12px 40px rgba(0,0,0,0.4)',zIndex:100}}>
          {/* Identity block — current name + "session-only" label.
              Always visible (doesn't get replaced by the edit input).
              When editing, the input drops in as a new row below. The
              "session-only" sub-label flips to a transient "changed" /
              "unchanged" confirmation after a submit. */}
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--border)'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,minWidth:0}}>
              <div style={{fontSize:12,fontWeight:700,color:'var(--fg)',minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName || 'anon'}</div>
              <RoleBadge role={role} />
            </div>
            <div style={{
              fontSize:9,
              marginTop:2,
              letterSpacing:'0.06em',
              textTransform:'uppercase',
              color: flash === 'changed' ? 'var(--accent2)'
                : flash === 'unchanged' ? 'var(--fg-dim)'
                : 'var(--fg-dim)',
            }}>
              {flash === 'changed' ? '✓ changed'
                : flash === 'unchanged' ? '— unchanged'
                : 'session-only name'}
            </div>
            {editing && (
              <div style={{display:'flex',gap:6,alignItems:'center',marginTop:8}}>
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); submitRename() }
                    if (e.key === 'Escape') { setEditing(false); setError(null); setDraft(bareName) }
                  }}
                  disabled={saving}
                  maxLength={64}
                  style={{flex:1,minWidth:0,fontSize:12,fontWeight:700,fontFamily:'var(--mono)',padding:'4px 6px',border:'1px solid var(--border2)',background:'var(--bg)',color:'var(--fg)',borderRadius:4}}
                />
                <button
                  onClick={submitRename}
                  disabled={saving}
                  aria-label="Confirm rename"
                  style={{background:'var(--accent)',color:'var(--bg)',border:'none',width:24,height:24,borderRadius:4,cursor:saving?'default':'pointer',fontSize:12,fontWeight:700,opacity:saving?0.6:1,flexShrink:0}}
                >✓</button>
              </div>
            )}
            {error && (
              <div style={{fontSize:10,color:'rgba(184,64,64,0.9)',marginTop:6}}>{error}</div>
            )}
          </div>

          {/* Inline rename trigger. Hidden during edit mode. */}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              style={{display:'block',width:'100%',textAlign:'left',padding:'9px 12px',fontSize:11,color:'var(--fg-dim)',fontFamily:'var(--mono)',letterSpacing:'0.04em',background:'none',border:'none',borderBottom:'1px solid var(--border)',cursor:'pointer'}}
            >
              ✎  Change name
            </button>
          )}

          {/* Sign-in / Sign-up CTAs. Same pattern as UserMenu's Link
              items but pointing at auth routes since anons have no
              account. */}
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            style={{display:'block',padding:'9px 12px',fontSize:11,color:'var(--accent)',textDecoration:'none',fontFamily:'var(--mono)',letterSpacing:'0.04em',borderBottom:'1px solid var(--border)'}}
          >
            →  Sign in
          </Link>
          <Link
            href="/register"
            onClick={() => setOpen(false)}
            style={{display:'block',padding:'9px 12px',fontSize:11,color:'var(--fg-dim)',textDecoration:'none',fontFamily:'var(--mono)',letterSpacing:'0.04em'}}
          >
            →  Sign up
          </Link>
        </div>
      )}
    </div>
  )
}
