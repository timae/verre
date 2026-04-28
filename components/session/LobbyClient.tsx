'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import Link from 'next/link'

type User = { id: string; name: string; email: string; role: string; pro: boolean } | null

export function LobbyClient({ user }: { user: User }) {
  const router = useRouter()
  const [displayName, setDisplayName] = useState(user?.name || '')
  const [sessionName, setSessionName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function createSession() {
    if (!displayName.trim()) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName: displayName.trim(), sessionName: sessionName.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Could not create session'); return }
    const { code } = await res.json()
    router.push(`/session/${code}?host=1&name=${encodeURIComponent(displayName.trim())}`)
  }

  async function joinSession() {
    if (!displayName.trim()) { setError('Enter your name'); return }
    if (!joinCode.trim() || joinCode.trim().length < 4) { setError('Enter a 4-char code'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: joinCode.trim().toUpperCase(), userName: displayName.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Session not found'); return }
    router.push(`/session/${joinCode.trim().toUpperCase()}?name=${encodeURIComponent(displayName.trim())}`)
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 md:p-8">
      <header className="flex items-center justify-between mb-8 max-w-4xl mx-auto">
        <div className="text-accent font-extrabold tracking-widest text-xl uppercase">
          Verre <span className="text-xs border border-border2 px-1.5 py-0.5 rounded text-fg-dim font-normal ml-1">v3</span>
        </div>
        {user ? (
          <button onClick={() => signOut()} className="text-xs text-fg-dim hover:text-fg">
            {user.name} · sign out
          </button>
        ) : (
          <Link href="/login" className="text-xs text-accent hover:underline">Sign in</Link>
        )}
      </header>

      <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-4 items-start">
        {/* Session card */}
        <div className="bg-bg2/80 border border-border rounded-card p-6 backdrop-blur-sm">
          <p className="text-xs text-accent2 uppercase tracking-widest mb-1">Start or join</p>
          <h2 className="text-2xl font-bold text-fg mb-6">Open the table</h2>

          <label className="block text-xs text-fg-dim uppercase tracking-widest mb-1">Your name</label>
          <input
            value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-fg text-sm mb-1 focus:outline-none focus:border-accent"
            placeholder="firstname or alias"
          />

          <label className="block text-xs text-fg-dim uppercase tracking-widest mb-1 mt-3">
            Session name <span className="normal-case opacity-60">(optional)</span>
          </label>
          <input
            value={sessionName} onChange={e => setSessionName(e.target.value)} maxLength={80}
            className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-fg text-sm mb-4 focus:outline-none focus:border-accent"
            placeholder="e.g. Friday Bordeaux tasting"
          />

          <button
            onClick={createSession} disabled={loading}
            className="w-full bg-accent text-bg font-bold py-2.5 rounded-lg text-sm mb-3 disabled:opacity-50"
          >
            → Create new tasting
          </button>

          <div className="flex items-center gap-3 my-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-fg-dim uppercase tracking-widest">or join</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <input
            value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())}
            maxLength={4} placeholder="A3F7"
            className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-fg text-lg text-center tracking-widest mb-3 focus:outline-none focus:border-accent"
          />
          <button
            onClick={joinSession} disabled={loading}
            className="w-full bg-bg3 border border-border text-fg font-bold py-2.5 rounded-lg text-sm disabled:opacity-50"
          >
            → Join session
          </button>

          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

          <Link href="/hof" className="block text-center text-xs text-fg-dim mt-4 hover:text-accent">
            ★ Hall of Fame
          </Link>
        </div>

        {/* Account card */}
        <div className="bg-bg2/80 border border-border rounded-card p-6 backdrop-blur-sm">
          {user ? (
            <AccountDashboard user={user} />
          ) : (
            <AccountPromo />
          )}
        </div>
      </div>
    </div>
  )
}

function AccountPromo() {
  return (
    <>
      <h2 className="text-3xl font-extrabold text-fg leading-none mb-2">
        Your palate,<br />remembered.
      </h2>
      <p className="text-xs text-fg-dim leading-relaxed mb-6">
        Create a free account to save your history, bookmark wines, and build your flavour profile over time.
      </p>
      <div className="space-y-2 mb-6">
        {[
          'Save and revisit any tasting session',
          'Bookmark wines across sessions',
          'Hall of Fame entries credited to you',
          'Flavour radar profile over time',
        ].map(perk => (
          <div key={perk} className="flex items-center gap-2 text-xs text-fg-dim">
            <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
            {perk}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Link
          href="/register"
          className="flex-1 bg-accent text-bg font-bold py-2.5 rounded-lg text-sm text-center"
        >
          Create account
        </Link>
        <Link
          href="/login"
          className="flex-1 bg-bg3 border border-border text-fg font-bold py-2.5 rounded-lg text-sm text-center"
        >
          Sign in
        </Link>
      </div>
    </>
  )
}

function AccountDashboard({ user }: { user: NonNullable<User> }) {
  return (
    <>
      <div className="flex items-center gap-3 mb-5">
        <div className="w-2 h-2 rounded-full bg-accent2" />
        <div>
          <p className="font-bold text-sm text-fg">{user.name}</p>
          <p className="text-xs text-fg-dim">{user.email}</p>
        </div>
      </div>
      <div className="space-y-2">
        {[
          { href: '/me', label: '→ My dashboard' },
          { href: '/me/history', label: '◷ Tasting history' },
          { href: '/me/saved', label: '★ Saved wines' },
          { href: '/me/profile', label: '◉ Flavour profile' },
        ].map(({ href, label }) => (
          <Link
            key={href} href={href}
            className="block w-full text-left px-3 py-2.5 rounded-lg bg-bg3 border border-border text-sm text-fg hover:border-accent transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>
    </>
  )
}
