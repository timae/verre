'use client'
import { useState } from 'react'
import { useSession } from 'next-auth/react'

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

export function AccountSettings() {
  const { data: authSession } = useSession()
  const user = authSession?.user as { name: string; email: string } | undefined

  const [name,      setName]      = useState(user?.name  || '')
  const [email,     setEmail]     = useState(user?.email || '')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw,     setNewPw]     = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState('')

  async function saveAccount() {
    setSaving(true); setError(''); setSuccess('')

    if (newPw && newPw.length < 8) {
      setError('Password must be at least 8 characters.')
      setSaving(false); return
    }
    if (newPw && newPw !== confirmPw) {
      setError('New passwords do not match.')
      setSaving(false); return
    }

    const body: Record<string, string> = {}
    if (name  !== user?.name)  body.name  = name
    if (email !== user?.email) body.email = email
    if (newPw) { body.currentPassword = currentPw; body.newPassword = newPw }
    if (Object.keys(body).length === 0) { setSaving(false); return }

    const res = await fetch('/api/me/account', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (res.ok) {
      setSuccess('changes saved')
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
    } else {
      const d = await res.json(); setError(d.error || 'update failed')
    }
  }

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
      <PasswordField label="current password" value={currentPw} onChange={setCurrentPw} placeholder="required to change password" autoComplete="current-password" />
      <PasswordField label="new password" value={newPw} onChange={setNewPw} placeholder="min 8 characters" autoComplete="new-password" hint="Use at least 8 characters." />
      <PasswordField label="confirm new password" value={confirmPw} onChange={setConfirmPw} placeholder="retype new password" autoComplete="new-password" />
      {error   && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
      {success && <p style={{color:'var(--accent2)',fontSize:11,marginBottom:8}}>✓ {success}</p>}
      <button className="btn-p" onClick={saveAccount} disabled={saving}>{saving ? 'saving…' : '→ save changes'}</button>
    </div>
  )
}
