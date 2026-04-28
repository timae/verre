'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    const res = await signIn('credentials', { email, password, redirect: false })
    setLoading(false)
    if (res?.error) { setError('Invalid email or password'); return }
    router.push('/'); router.refresh()
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <div className="fl">email</div>
        <input className="fi" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email" />
      </div>
      <div className="field">
        <div className="fl">password</div>
        <input className="fi" type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••" autoComplete="current-password" />
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
