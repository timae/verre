'use client'
import { useState, useEffect } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { clearSessionNames } from '@/lib/clientStorage'
import { TIER_LABELS, TIER_ORDER, type ProfileVisibility } from '@/lib/profileVisibilityShared'

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

function PasswordField({ label, value, onChange, placeholder, autoComplete, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; autoComplete?: string; hint?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="field">
      <div className="fl">{label}</div>
      <div style={{position:'relative'}}>
        <input
          className="fi" type={show ? 'text' : 'password'} value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder} autoComplete={autoComplete}
          style={{paddingRight:36}}
        />
        <button
          type="button" onClick={() => setShow(s => !s)}
          style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',
            background:'none',border:'none',cursor:'pointer',color:'var(--fg-dim)',padding:2,lineHeight:0}}
          tabIndex={-1}
        >
          <EyeIcon open={show} />
        </button>
      </div>
      {hint && <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:4}}>{hint}</div>}
    </div>
  )
}

// `onSaved` fires after a successful account update — lets a parent
// (e.g. the settings modal) close itself and refetch its data. Not
// called for password-only changes since those don't change anything
// the parent renders, but it's harmless if a caller still acts on
// every save — the post-save state is the same.
// API the modal-driven caller (AccountSettingsModal) uses to drive the
// footer Save button and surface state above the footer. The inline
// "save changes" button was removed; the shared component now requires
// a hosting surface that wires `onReady` — the modal is the only such
// surface today.
//
// - save() returns when the operation resolves (success or error).
// - saving is the live in-flight flag for disabled-state on the footer.
// - dirty is true iff the user has unsaved changes in the form. The
//   modal uses this to gate close-on-Escape / X / backdrop with a
//   confirm prompt.
// - error / success surface the inline messages above the footer so
//   they're visible even when the form is scrolled out of view.
export interface AccountSettingsApi {
  // Returns true on a successful save (server 200) OR a no-op (no
  // pending changes). Returns false on any error path so the modal
  // can keep its dirty-guard confirm open and surface the error.
  save: () => Promise<boolean>
  saving: boolean
  dirty: boolean
  error: string
  success: string
}

interface Props {
  onSaved?: () => void
  // Optional. When passed, the host (typically AccountSettingsModal)
  // takes over the save action via the api callback and the inline
  // "save changes" button is hidden. The host is responsible for
  // exposing a Save affordance somewhere (typically a footer button).
  onReady?: (api: AccountSettingsApi) => void
}

export function AccountSettings({ onSaved, onReady }: Props = {}) {
  const { data: authSession, update } = useSession()
  const user = authSession?.user as { name: string; email: string } | undefined

  const [name,      setName]      = useState(user?.name  || '')
  const [email,     setEmail]     = useState(user?.email || '')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw,     setNewPw]     = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState('')

  // Returns true on success / no-op, false on any error.
  async function saveAccount(): Promise<boolean> {
    setSaving(true); setError(''); setSuccess('')

    if (newPw && newPw.length < 8) {
      setError('Password must be at least 8 characters.')
      setSaving(false); return false
    }
    if (newPw && newPw !== confirmPw) {
      setError('New passwords do not match.')
      setSaving(false); return false
    }
    // User entered current-password but no new-password — they likely
    // intended to change their password but forgot the new one. Without
    // this guard the body would be empty (newPw is the only thing that
    // routes currentPw into the body), Save would silently no-op, and
    // the user would think the wrong-current-pw check passed.
    if (currentPw && !newPw) {
      setError('Enter a new password to change it, or clear the current-password field.')
      setSaving(false); return false
    }

    const body: Record<string, string> = {}
    if (name  !== user?.name)  body.name  = name
    if (email !== user?.email) body.email = email
    if (newPw) { body.currentPassword = currentPw; body.newPassword = newPw }
    if (Object.keys(body).length === 0) { setSaving(false); return true }

    const res = await fetch('/api/me/account', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (res.status === 401) { window.location.href = '/login'; return false }
    if (res.ok) {
      // Surface how many other devices the password change signed out, so the
      // user notices if a session they didn't expect got terminated (the v1
      // mitigation for the change-from-a-compromised-session case).
      const d = await res.json().catch(() => ({}))
      const n = typeof d.otherDevicesSignedOut === 'number' ? d.otherDevicesSignedOut : null
      setSuccess(n && n > 0 ? `changes saved · signed out ${n} other device${n === 1 ? '' : 's'}` : 'changes saved')
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      // Refresh the NextAuth JWT so other consumers of `useSession` (e.g.
      // UserMenu, ProfileTabs deeper in the tree) see the new display
      // name without a page reload. Then signal the parent — typically a
      // settings modal that closes itself and triggers `router.refresh()`
      // to re-run the SSR profile page.
      if (body.name || body.email) await update()
      onSaved?.()
      return true
    }
    const d = await res.json(); setError(d.error || 'update failed')
    return false
  }

  // Dirty = any modifiable field differs from the loaded session state
  // OR a password-change is in progress (any of the three password
  // fields filled). Password fields aren't compared to a baseline
  // because the JWT doesn't carry the password hash — presence alone
  // means the user is trying to change something.
  const dirty = (
    name !== (user?.name ?? '') ||
    email !== (user?.email ?? '') ||
    !!currentPw || !!newPw || !!confirmPw
  )

  // Publish the save API + state to the host (modal) on every relevant
  // change so the footer button + close-guard + inline messages stay
  // in sync. `saveAccount` closes over the latest input state via
  // React closures — the host never holds a stale reference.
  // `user?.name` / `user?.email` are in the dep list because `update()`
  // after a successful save flips the session-side values, which would
  // otherwise stale-true the `dirty` derivation without firing this
  // effect (local state didn't change; only the JWT baseline did).
  useEffect(() => {
    onReady?.({ save: saveAccount, saving, dirty, error, success })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, dirty, error, success, name, email, currentPw, newPw, confirmPw, user?.name, user?.email])

  if (!user) return null

  return (
    <div>
      <div className="field">
        <div className="fl">display name</div>
        <input className="fi" value={name} onChange={e => setName(e.target.value)} maxLength={64} />
      </div>
      <div className="field">
        <div className="fl">email</div>
        <input className="fi" type="email" value={email} onChange={e => setEmail(e.target.value)} />
      </div>
      <div style={{marginTop:12,marginBottom:6,fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.08em',textTransform:'uppercase'}}>change password</div>
      <div style={{fontSize:10,color:'var(--fg-dim)',marginBottom:8,lineHeight:1.5}}>Changing your password signs you out on all your other devices.</div>
      <PasswordField label="current password" value={currentPw} onChange={setCurrentPw} placeholder="required to change password" autoComplete="current-password" />
      <PasswordField label="new password" value={newPw} onChange={setNewPw} placeholder="min 8 characters" autoComplete="new-password" hint="Use at least 8 characters." />
      <PasswordField label="confirm new password" value={confirmPw} onChange={setConfirmPw} placeholder="retype new password" autoComplete="new-password" />
      {/* Inline save button + error/success messages removed — the
          hosting AccountSettingsModal drives save via the onReady api
          and renders the messages near the footer Save so they stay
          visible regardless of scroll position. */}

      <ProfileVisibilitySection />
      <ConnectedDevicesSection />
      <BlockedUsersSection />
      <DangerZone email={user.email} />
    </div>
  )
}

// Lists the users this account has blocked, with an unblock affordance
// per row. Read-only otherwise; new blocks happen via the 3-dot menu on
// profile headers. Newest-first; capped at the same BLOCK_PAIR_CAP that
// powers the runtime filter (1000) — beyond that, the count itself is
// abuse-scenario territory.
function BlockedUsersSection() {
  type Row = { id: number; name: string; imageUrl: string | null; createdAt: string }
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState<number | null>(null)

  async function refresh() {
    setError('')
    try {
      const res = await fetch('/api/me/blocks')
      if (!res.ok) { setRows([]); setError('Could not load blocked users.'); return }
      const data = await res.json()
      setRows(data.blocks ?? [])
    } catch {
      setRows([])
      setError('Could not load blocked users.')
    }
  }
  // Fire once on mount. `refresh` is a fresh closure each render and we
  // don't want it as a dep — adding it would loop or require useCallback
  // boilerplate that buys nothing for this single-mount fetch.
  useEffect(() => { refresh() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function unblock(id: number) {
    if (working !== null) return
    setWorking(id)
    const res = await fetch(`/api/me/blocks/${id}`, { method: 'DELETE' })
    setWorking(null)
    if (res.ok) refresh()
    else setError('Could not unblock.')
  }

  return (
    <div style={{marginTop:32,paddingTop:20,borderTop:'1px solid var(--border)'}}>
      <div style={{fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.14em',textTransform:'uppercase',marginBottom:10}}>blocked users</div>
      {rows === null && <div style={{fontSize:11,color:'var(--fg-dim)'}}>loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div style={{fontSize:11,color:'var(--fg-dim)'}}>You haven&rsquo;t blocked anyone.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {rows.map(r => (
            <div key={r.id} style={{
              display:'flex',alignItems:'center',gap:10,padding:'8px 12px',
              borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',
            }}>
              <div style={{flex:1,minWidth:0,fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                {r.name}
              </div>
              <button
                onClick={() => unblock(r.id)}
                disabled={working === r.id}
                className="btn-s"
                style={{
                  background:'rgba(184,64,64,0.08)',
                  borderColor:'rgba(184,64,64,0.4)',
                  color:'rgba(184,64,64,0.95)',
                }}
              >
                {working === r.id ? '…' : 'unblock'}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p style={{color:'#e07070',fontSize:11,marginTop:8}}>{error}</p>}
    </div>
  )
}

// "Last seen" label rounded to the 5-minute bucket the value is stored at
// (auth.ts bumps lastSeenAt to the bucket START, so finer-grained copy like
// "3m ago" would imply precision the data doesn't carry — proposal §10).
function lastSeenLabel(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 600) return 'active recently'            // within ~2 buckets
  if (secs < 3600) return `${Math.floor(secs / 300) * 5}m ago`  // rounded to 5
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

type Device = {
  id: string; deviceLabel: string | null; geoLabel: string | null
  createdAt: string; lastSeenAt: string; isCurrent: boolean
}

// "Connected devices" — lists the account's active per-device sessions and
// offers per-device + revoke-all sign-out. Self-only data (GET /api/me/devices
// is WHERE userId = $me). Mirrors the BlockedUsersSection / DangerZone shape:
// inline expand-confirm for the password-gated revoke-all, no separate modal.
function ConnectedDevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  // revoke-all inline confirm
  const [allOpen, setAllOpen] = useState(false)
  const [allPw, setAllPw] = useState('')
  const [allBusy, setAllBusy] = useState(false)
  const [allErr, setAllErr] = useState('')
  // cross-device per-row confirm (which row is asking for a password)
  const [pwFor, setPwFor] = useState<string | null>(null)
  const [rowPw, setRowPw] = useState('')
  const [okMsg, setOkMsg] = useState('')

  async function refresh() {
    setError('')
    try {
      const res = await fetch('/api/me/devices')
      if (!res.ok) { setDevices([]); setError('Could not load devices.'); return }
      const data = await res.json()
      setDevices(data.devices ?? [])
    } catch {
      setDevices([]); setError('Could not load devices.')
    }
  }
  useEffect(() => { refresh() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // Auto-clear the success echo so it can't hang stale below a now-shorter list
  // (after revoke-all the button that would otherwise reset it disappears).
  useEffect(() => {
    if (!okMsg) return
    const t = setTimeout(() => setOkMsg(''), 3000)
    return () => clearTimeout(t)
  }, [okMsg])

  // Disconnect a device.
  // Current session → just log yourself out: signOut() clears the cookie AND
  // the events.signOut hook in auth.ts revokes this device's row. No password,
  // no DELETE call needed (one canonical action instead of two round-trips).
  // Cross-device → DELETE with the password collected in the per-row confirm.
  async function disconnect(d: Device, password?: string) {
    if (working !== null) return
    if (d.isCurrent) { setWorking(d.id); try { clearSessionNames() } catch {}; await signOut({ callbackUrl: '/login' }); return }
    setWorking(d.id); setError('')
    const res = await fetch(`/api/me/devices/${d.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    })
    setWorking(null)
    if (res.ok) {
      setPwFor(null); setRowPw('')
      refresh()
      return
    }
    const data = await res.json().catch(() => ({}))
    setOkMsg('')  // mutually exclusive with the error slot
    if (res.status === 403) setError('Password incorrect.')
    else setError(data.error || 'Could not disconnect that device.')
  }

  async function revokeAll() {
    setAllBusy(true); setAllErr('')
    const res = await fetch('/api/me/devices', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: allPw }),
    })
    setAllBusy(false)
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      setAllOpen(false); setAllPw('')
      setError('')  // mutually exclusive with the success echo below
      setOkMsg(`Signed out of ${data.revoked ?? 0} other device${data.revoked === 1 ? '' : 's'}.`)
      refresh()
      return
    }
    if (res.status === 403) setAllErr('Password incorrect.')
    else { const d = await res.json().catch(() => ({})); setAllErr(d.error || 'Could not sign out other devices.') }
  }

  const others = (devices ?? []).filter(d => !d.isCurrent)

  return (
    <div style={{marginTop:32,paddingTop:20,borderTop:'1px solid var(--border)'}}>
      <div style={{fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.14em',textTransform:'uppercase',marginBottom:10}}>connected devices</div>

      {devices === null && <div style={{fontSize:11,color:'var(--fg-dim)'}}>loading…</div>}

      {devices !== null && devices.length === 0 && (
        <div style={{fontSize:11,color:'var(--fg-dim)'}}>No active devices.</div>
      )}

      {devices !== null && devices.length > 0 && (
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {devices.map(d => (
            <div key={d.id} style={{display:'flex',flexDirection:'column',gap:8,padding:'8px 12px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)'}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {d.deviceLabel || 'Unknown device'}
                    {d.isCurrent && <span style={{marginLeft:8,fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase'}}>· this device</span>}
                  </div>
                  <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>
                    {/* geoLabel is null for all rows in v1 (no geo source wired
                        yet) — omit the segment entirely rather than render a
                        useless "Unknown location" on every row. createdAt is
                        shown so two same-browser logins (identical deviceLabel)
                        are still distinguishable for targeted revocation. */}
                    {d.geoLabel && <>{d.geoLabel} · </>}
                    signed in {new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {' · last seen '}{lastSeenLabel(d.lastSeenAt)}
                  </div>
                </div>
                <button
                  onClick={() => { setPwFor(pwFor === d.id ? null : d.id); setRowPw(''); setError('') }}
                  disabled={working === d.id}
                  className="btn-s"
                  style={{background:'rgba(184,64,64,0.08)',borderColor:'rgba(184,64,64,0.4)',color:'rgba(184,64,64,0.95)'}}
                >
                  {working === d.id ? '…' : d.isCurrent ? 'sign out' : 'disconnect'}
                </button>
              </div>
              {/* Inline confirm. Current device: no password (logging yourself
                  out), but still a confirm step since the consequence — bounced
                  to /login — is abrupt. Other device: password re-auth. */}
              {pwFor === d.id && (
                <div style={{display:'flex',flexDirection:'column',gap:6,paddingTop:6,borderTop:'1px solid var(--border)'}}>
                  {d.isCurrent ? (
                    <div style={{fontSize:10,color:'var(--fg-dim)'}}>Sign out of this device? You&rsquo;ll need to log back in.</div>
                  ) : (
                    <>
                      <div style={{fontSize:10,color:'var(--fg-dim)'}}>Enter your password to disconnect this device.</div>
                      <input className="fi" type="password" value={rowPw} onChange={e => setRowPw(e.target.value)} placeholder="password" autoComplete="current-password" />
                    </>
                  )}
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={() => { setPwFor(null); setRowPw(''); setError('') }} className="btn-s" style={{flex:1}}>cancel</button>
                    <button onClick={() => disconnect(d, d.isCurrent ? undefined : rowPw)} disabled={(!d.isCurrent && rowPw.length === 0) || working === d.id} className="btn-s"
                      style={{flex:1,background:'rgba(184,64,64,0.08)',borderColor:'rgba(184,64,64,0.4)',color:'rgba(184,64,64,0.95)'}}>
                      {d.isCurrent ? 'sign out' : 'confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Revoke-all — only meaningful when there are OTHER devices to revoke. */}
      {devices !== null && others.length > 0 && (
        <div style={{marginTop:10}}>
          {!allOpen ? (
            <button onClick={() => { setAllOpen(true); setOkMsg('') }} className="btn-s"
              style={{background:'rgba(184,64,64,0.08)',borderColor:'rgba(184,64,64,0.4)',color:'rgba(184,64,64,0.95)'}}>
              sign out of all other devices
            </button>
          ) : (
            <div style={{padding:14,border:'1px solid rgba(224,112,112,0.3)',borderRadius:6,background:'rgba(224,112,112,0.04)'}}>
              <p style={{fontSize:12,marginBottom:10,lineHeight:1.5}}>Sign out everywhere except this device. Enter your password to confirm.</p>
              <div className="field">
                <div className="fl">password</div>
                <input className="fi" type="password" value={allPw} onChange={e => setAllPw(e.target.value)} autoComplete="current-password" />
              </div>
              {allErr && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{allErr}</p>}
              <div style={{display:'flex',gap:8}}>
                <button onClick={() => { setAllOpen(false); setAllPw(''); setAllErr('') }} className="btn-s" style={{flex:1}}>cancel</button>
                <button onClick={revokeAll} disabled={allPw.length === 0 || allBusy} className="btn-s"
                  style={{flex:1,background:'rgba(184,64,64,0.08)',borderColor:'rgba(184,64,64,0.4)',color:'rgba(184,64,64,0.95)'}}>
                  {allBusy ? '…' : 'sign out others'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {okMsg && <p style={{color:'var(--accent2)',fontSize:11,marginTop:8}}>✓ {okMsg}</p>}
      {error && <p style={{color:'#e07070',fontSize:11,marginTop:8}}>{error}</p>}
    </div>
  )
}

function ProfileVisibilitySection() {
  const [tier, setTier] = useState<ProfileVisibility | null>(null)
  const [fofEnabled, setFofEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/me/visibility')
      .then(r => r.json())
      .then((d: { visibility: ProfileVisibility; fofEnabled: boolean }) => {
        if (cancelled) return
        setTier(d.visibility)
        setFofEnabled(d.fofEnabled)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function save(newTier: ProfileVisibility, newFof: boolean) {
    setSaving(true); setError(''); setSuccess('')
    // FoF is meaningless on public tiers — coerce to false on the wire so
    // the stored bit matches what the UI shows. Without this, a user who
    // turns FoF on at `public-mutual` then drops to `public-users` would
    // carry FoF=true silently in the DB.
    const wireFof = (newTier === 'public-internet' || newTier === 'public-users') ? false : newFof
    const res = await fetch('/api/me/visibility', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: newTier, fofEnabled: wireFof }),
    })
    setSaving(false)
    if (res.status === 401) { window.location.href = '/login'; return }
    if (res.ok) {
      setTier(newTier); setFofEnabled(wireFof); setSuccess('saved')
      setTimeout(() => setSuccess(''), 2000)
    } else {
      const d = await res.json().catch(() => ({}))
      setError(d.error || 'failed to save')
    }
  }

  // FoF only meaningful for follower/mutual tiers — broader tiers already
  // admit anyone who'd qualify via the indirect chain.
  const fofRelevant = tier === 'public-followers' || tier === 'public-mutual'

  return (
    <div style={{marginTop:32,paddingTop:20,borderTop:'1px solid var(--border)'}}>
      <div style={{fontSize:9,color:'var(--fg-faint)',letterSpacing:'0.14em',textTransform:'uppercase',marginBottom:10}}>profile visibility</div>
      {loading ? (
        <div style={{fontSize:11,color:'var(--fg-dim)'}}>loading…</div>
      ) : tier === null ? (
        <div style={{fontSize:11,color:'#e07070'}}>could not load settings</div>
      ) : (
        <>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {TIER_ORDER.map(t => {
              const sel = t === tier
              return (
                <button key={t} type="button" disabled={saving}
                  onClick={() => save(t, fofEnabled)}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
                    background: sel ? 'rgba(200,150,60,0.08)' : 'var(--bg3)',
                    cursor: saving ? 'wait' : 'pointer',
                    color: 'var(--fg)',
                    fontFamily: 'var(--mono)',
                  }}>
                  <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.04em'}}>{sel ? '● ' : '○ '}{TIER_LABELS[t].title}</div>
                  <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2,marginLeft:14}}>{TIER_LABELS[t].sub}</div>
                </button>
              )
            })}
          </div>
          {fofRelevant && (
            <div style={{marginTop:14,padding:'10px 12px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,cursor:saving?'wait':'pointer'}}
              onClick={() => !saving && save(tier, !fofEnabled)}>
              <div>
                <div style={{fontSize:11,fontWeight:700}}>Friends of friends</div>
                <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>also let people one connection away through someone I trust</div>
              </div>
              <div style={{ width: 36, height: 20, borderRadius: 10, background: fofEnabled ? 'var(--accent)' : 'var(--bg4)', border: '1px solid var(--border2)', position: 'relative', flexShrink: 0 }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: fofEnabled ? 18 : 2, transition: 'left .2s' }} />
              </div>
            </div>
          )}
          {error   && <p style={{color:'#e07070',fontSize:11,marginTop:8}}>{error}</p>}
          {success && <p style={{color:'var(--accent2)',fontSize:11,marginTop:8}}>✓ {success}</p>}
        </>
      )}
    </div>
  )
}

function DangerZone({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [pw,   setPw]   = useState('')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')

  const canSubmit = pw.length > 0 && !busy

  async function deleteAccount() {
    setBusy(true); setErr('')
    const res = await fetch('/api/me/account', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    if (res.ok) {
      // Wipe per-session client cache so other tabs don't render with the
      // stale display name / identity once the auth cookie is gone.
      try { clearSessionNames() } catch {}
      await signOut({ callbackUrl: '/' })
      return
    }
    setBusy(false)
    const d = await res.json().catch(() => ({}))
    setErr(d.error || 'deletion failed')
  }

  return (
    <div style={{marginTop:32,paddingTop:20,borderTop:'1px solid rgba(224,112,112,0.18)'}}>
      <div style={{fontSize:9,color:'#e07070',letterSpacing:'0.14em',textTransform:'uppercase',marginBottom:8}}>danger zone</div>
      {!open ? (
        <button onClick={() => setOpen(true)}
          style={{background:'transparent',border:'1px solid rgba(224,112,112,0.4)',color:'#e07070',padding:'8px 14px',fontFamily:'var(--mono)',fontSize:11,letterSpacing:'0.06em',cursor:'pointer',borderRadius:3}}>
          delete account
        </button>
      ) : (
        <div style={{padding:14,border:'1px solid rgba(224,112,112,0.3)',borderRadius:6,background:'rgba(224,112,112,0.04)'}}>
          <p style={{fontSize:12,marginBottom:10,lineHeight:1.5}}>
            This is permanent. Your bookmarks and badges will be deleted. Your ratings in active sessions stay visible to other tasters but attributed to <em>[deleted]</em>.
          </p>
          <p style={{fontSize:12,marginBottom:14,lineHeight:1.5}}>
            Sessions you host: if no one other than you has rated yet, the session is deleted entirely. If others have rated, the session keeps running under <em>[deleted]</em> so they can finish — your co-hosts (if any) inherit the right to delete it.
          </p>
          <div className="field">
            <div className="fl">deleting account for</div>
            <div style={{padding:'8px 10px',background:'var(--bg3)',borderRadius:3,border:'1px solid var(--border)',fontFamily:'var(--mono)',fontSize:12,color:'var(--fg)'}}>{email}</div>
          </div>
          <div className="field">
            <div className="fl">password</div>
            <input className="fi" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
          </div>
          {err && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{err}</p>}
          <div style={{display:'flex',gap:8}}>
            <button onClick={() => { setOpen(false); setPw(''); setErr('') }}
              style={{background:'transparent',border:'1px solid var(--border2)',color:'var(--fg-dim)',padding:'8px 14px',fontFamily:'var(--mono)',fontSize:11,letterSpacing:'0.06em',cursor:'pointer',borderRadius:3,flex:1}}>
              cancel
            </button>
            <button onClick={deleteAccount} disabled={!canSubmit}
              style={{background:canSubmit?'#e07070':'rgba(224,112,112,0.3)',border:'none',color:canSubmit?'#1a0a0a':'rgba(255,255,255,0.4)',padding:'8px 14px',fontFamily:'var(--mono)',fontSize:11,letterSpacing:'0.06em',cursor:canSubmit?'pointer':'not-allowed',borderRadius:3,flex:1,fontWeight:700}}>
              {busy ? 'deleting…' : '→ delete forever'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
