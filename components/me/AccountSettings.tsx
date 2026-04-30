'use client'
import { useState } from 'react'
import { useSession } from 'next-auth/react'

export function AccountSettings() {
  const { data: authSession } = useSession()
  const user = authSession?.user as { name: string; email: string } | undefined

  const [name,      setName]      = useState(user?.name  || '')
  const [email,     setEmail]     = useState(user?.email || '')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw,     setNewPw]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState('')

  async function saveAccount() {
    setSaving(true); setError(''); setSuccess('')
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
    if (res.ok) { setSuccess('changes saved'); setCurrentPw(''); setNewPw('') }
    else { const d = await res.json(); setError(d.error || 'update failed') }
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
      <div className="field">
        <div className="fl">current password</div>
        <input className="fi" type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} placeholder="required to change password" />
      </div>
      <div className="field">
        <div className="fl">new password</div>
        <input className="fi" type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="min 8 characters" />
      </div>
      {error   && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
      {success && <p style={{color:'var(--accent2)',fontSize:11,marginBottom:8}}>✓ {success}</p>}
      <button className="btn-p" onClick={saveAccount} disabled={saving}>{saving ? 'saving…' : '→ save changes'}</button>
    </div>
  )
}
