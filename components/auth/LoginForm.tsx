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

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Format seconds into a human-readable wait message.
  function humanWait(secs: number): string {
    return secs < 60
      ? `${secs} second${secs === 1 ? '' : 's'}`
      : `${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) === 1 ? '' : 's'}`
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')

    // NextAuth v5 strips custom error messages out of signIn()'s response,
    // so we can't see "RATE_LIMITED:N" coming back from authorize(). Ask
    // the precheck endpoint first (peeks counters, no increment). If
    // already over the limit, show the friendly countdown and skip
    // signIn() entirely.
    try {
      const pre = await fetch('/api/auth/login-precheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (pre.ok) {
        const data = await pre.json()
        if (!data.allowed) {
          setLoading(false)
          setError(`Too many login attempts. Try again in ${humanWait(Number(data.retryAfter) || 60)}.`)
          return
        }
      }
    } catch {
      // Precheck failure is non-blocking — fall through to signIn() and let
      // the server-side limit do its job.
    }

    const res = await signIn('credentials', { email, password, redirect: false })
    setLoading(false)
    if (res?.error) {
      setError('Invalid email or password')
      return
    }
    router.push(redirectTo || '/me'); router.refresh()
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <div className="fl">email</div>
        <input className="fi" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email" />
      </div>
      <div className="field">
        <div className="fl">password</div>
        <div style={{position:'relative'}}>
          <input className="fi" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
            required placeholder="••••••••" autoComplete="current-password" style={{paddingRight:36}} />
          <button type="button" onClick={() => setShowPw(s => !s)}
            style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--fg-dim)',padding:2,lineHeight:0}}
            tabIndex={-1}>
            <EyeIcon open={showPw} />
          </button>
        </div>
      </div>
      {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
      <button className="btn-p" type="submit" disabled={loading}>{loading ? 'signing in…' : '→ sign in'}</button>
      <p style={{textAlign:'center',marginTop:12,fontSize:11,color:'var(--fg-dim)'}}>
        No account?{' '}
        <Link href="/register" style={{color:'var(--accent)'}}>Create one free</Link>
      </p>
    </form>
  )
}
