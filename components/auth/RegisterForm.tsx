'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
        <input className="fi" type={show ? 'text' : 'password'} value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder} autoComplete={autoComplete} style={{paddingRight:36}} />
        <button type="button" onClick={() => setShow(s => !s)}
          style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--fg-dim)',padding:2,lineHeight:0}}
          tabIndex={-1}>
          <EyeIcon open={show} />
        </button>
      </div>
      {hint && <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:4}}>{hint}</div>}
    </div>
  )
}

export function RegisterForm({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirmPw) { setError('Passwords do not match.'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Registration failed')
      setLoading(false); return
    }
    await signIn('credentials', { email, password, redirect: false })
    router.push(redirectTo || '/'); router.refresh()
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <div className="fl">name</div>
        <input className="fi" type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="firstname or alias" />
      </div>
      <div className="field">
        <div className="fl">email</div>
        <input className="fi" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email" />
      </div>
      <PasswordField label="password" value={password} onChange={setPassword} placeholder="min 8 characters" autoComplete="new-password" hint="Use at least 8 characters." />
      <PasswordField label="confirm password" value={confirmPw} onChange={setConfirmPw} placeholder="retype password" autoComplete="new-password" />
      {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
      <button className="btn-p" type="submit" disabled={loading}>{loading ? 'creating account…' : '→ create account'}</button>
      <p style={{textAlign:'center',marginTop:12,fontSize:11,color:'var(--fg-dim)'}}>
        Already have an account?{' '}
        <Link href="/login" style={{color:'var(--accent)'}}>Sign in</Link>
      </p>
    </form>
  )
}
