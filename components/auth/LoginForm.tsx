'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import Link from 'next/link'
import { safeRedirect } from '@/lib/safeRedirect'

// Record the just-used credential with the browser's password manager via the
// Credential Management API. Needed because the form submits via JS (so the
// browser never sees the values in a native submit). Feature-detected and
// fully best-effort: PasswordCredential is unavailable in some browsers (e.g.
// Firefox) and requires a secure context (https or localhost); any absence or
// failure is swallowed so login is never blocked.
async function storeCredential(email: string, password: string): Promise<void> {
  try {
    const PasswordCredentialCtor = (window as unknown as {
      PasswordCredential?: new (data: { id: string; password: string }) => Credential
    }).PasswordCredential
    if (!PasswordCredentialCtor || !navigator.credentials?.store) return
    const cred = new PasswordCredentialCtor({ id: email, password })
    await navigator.credentials.store(cred)
  } catch {
    // Best-effort — never block login on a credential-store failure.
  }
}

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

export function LoginForm({ redirectTo, notice }: { redirectTo?: string; notice?: string }) {
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
    if (res?.error) {
      setLoading(false)
      setError('Invalid email or password')
      return
    }
    // Explicitly hand the credential to the browser's password manager. The
    // login submits via JS (preventDefault, for the precheck + inline errors),
    // so the browser never witnesses a native form submission carrying these
    // values — which means the email/password are never recorded into autofill.
    // The Credential Management API records them directly. Best-effort and
    // feature-detected: PasswordCredential is absent in some browsers (e.g.
    // Firefox) and requires a secure context (https or localhost). Awaited so
    // the store lands before the hard navigation unloads the page; never blocks
    // login on failure.
    await storeCredential(email, password)
    // Hard navigation (not router.push) on success. A full document load is the
    // signal browsers use to detect a completed login and offer to save the
    // credential — a client-side route swap (router.push) leaves the password
    // field mounted with no navigation. Combined with name= + autocomplete= on
    // the inputs, this restores native autofill/save. Keep `loading` true
    // through the navigation so the button stays disabled until the page unloads.
    // safeRedirect: redirectTo is the attacker-supplied ?redirect= param, so
    // validate it's a same-origin relative path before navigating (no //evil.com
    // open redirect). Default /me.
    window.location.assign(safeRedirect(redirectTo, '/me'))
  }

  return (
    // method="post" is a security floor, not the active path: handleSubmit
    // preventDefaults and submits via signIn(). But if the JS handler never runs
    // (hydration race, chunk-load failure), the browser falls back to a NATIVE
    // submit — and a method-less form defaults to GET, which would serialize the
    // named email+password inputs into the URL (?email=…&password=… in logs,
    // history, Referer). method="post" forces that fallback into the request
    // body instead. action points at a real POST route handler that discards the
    // body and 303s back to /login — a guaranteed clean re-render, not the
    // incidental (version-dependent) behavior of POSTing to a page route. We keep
    // name= on the inputs (load-bearing for the password manager — storeCredential).
    // The ?redirect= is carried through so a failed retry returns to the original
    // flow (e.g. /join/<code>); the fallback route re-validates it (safeRedirect).
    <form
      method="post"
      action={redirectTo ? `/login/fallback?redirect=${encodeURIComponent(redirectTo)}` : '/login/fallback'}
      onSubmit={handleSubmit}
    >
      {notice && (
        <div style={{fontSize:11,lineHeight:1.5,color:'var(--fg-dim)',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:6,padding:'10px 12px',marginBottom:16}}>
          {notice}
        </div>
      )}
      <div className="field">
        <div className="fl">email</div>
        <input className="fi" type="email" name="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email" />
      </div>
      <div className="field">
        <div className="fl">password</div>
        <div style={{position:'relative'}}>
          <input className="fi" type={showPw ? 'text' : 'password'} name="password" value={password} onChange={e => setPassword(e.target.value)}
            required placeholder="••••••••" autoComplete="current-password" style={{paddingRight:36}} />
          <button type="button" onClick={() => setShowPw(s => !s)}
            style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--fg-dim)',padding:2,lineHeight:0}}
            tabIndex={-1}>
            <EyeIcon open={showPw} />
          </button>
        </div>
      </div>
      {error && <p style={{color:'var(--danger)',fontSize:11,marginBottom:8}}>{error}</p>}
      <button className="btn-p" type="submit" disabled={loading}>{loading ? 'signing in…' : '→ sign in'}</button>
      <p style={{textAlign:'center',marginTop:12,fontSize:11,color:'var(--fg-dim)'}}>
        No account?{' '}
        <Link href="/register" style={{color:'var(--accent)'}}>Create one free</Link>
      </p>
    </form>
  )
}
