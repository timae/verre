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
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Registration failed')
      setLoading(false)
      return
    }
    await signIn('credentials', { email, password, redirect: false })
    router.push('/')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs text-fg-dim mb-1 uppercase tracking-widest">Name</label>
        <input
          type="text" value={name} onChange={e => setName(e.target.value)} required
          className="w-full bg-bg2 border border-border rounded-lg px-3 py-2.5 text-fg text-sm focus:outline-none focus:border-accent"
          placeholder="firstname or alias"
        />
      </div>
      <div>
        <label className="block text-xs text-fg-dim mb-1 uppercase tracking-widest">Email</label>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)} required
          className="w-full bg-bg2 border border-border rounded-lg px-3 py-2.5 text-fg text-sm focus:outline-none focus:border-accent"
          placeholder="you@example.com" autoComplete="email"
        />
      </div>
      <div>
        <label className="block text-xs text-fg-dim mb-1 uppercase tracking-widest">Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8}
          className="w-full bg-bg2 border border-border rounded-lg px-3 py-2.5 text-fg text-sm focus:outline-none focus:border-accent"
          placeholder="min 8 characters" autoComplete="new-password"
        />
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <button
        type="submit" disabled={loading}
        className="w-full bg-accent text-bg font-bold py-2.5 rounded-lg text-sm disabled:opacity-50"
      >
        {loading ? 'Creating account…' : '→ Create account'}
      </button>
      <p className="text-center text-xs text-fg-dim">
        Already have an account?{' '}
        <Link href="/login" className="text-accent underline">Sign in</Link>
      </p>
    </form>
  )
}
