'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export function RegisterForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
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
    router.push('/'); router.refresh()
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
      <div className="field">
        <div className="fl">password</div>
        <input className="fi" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="min 8 characters" autoComplete="new-password" />
      </div>
      {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
      <button className="btn-p" type="submit" disabled={loading}>{loading ? 'creating account…' : '→ create account'}</button>
      <p style={{textAlign:'center',marginTop:12,fontSize:11,color:'var(--fg-dim)'}}>
        Already have an account?{' '}
        <Link href="/login" style={{color:'var(--accent)'}}>Sign in</Link>
      </p>
    </form>
  )
}
