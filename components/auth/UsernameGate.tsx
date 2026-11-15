'use client'
import { useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { usePathname } from 'next/navigation'
import { checkUsername } from '@verre/core'
import { clearSessionNames } from '@/lib/clientStorage'
import { UsernameField, usernameSaveError } from './UsernameField'

// A signed-in web session with no username yet sees the choose screen INSTEAD
// of the page, on every route, until a name is chosen (usernames § 10: the
// client blocks, there is no server-side lock). Rendered in place, never a
// redirect, so it cannot loop. No flash: the root layout seeds SessionProvider
// with the server's session, so the first render (server and client) already
// knows; an anonymous visitor (`data` null) and a session with a username fall
// straight through. Keyed on the session DATA, not `status`, which reads
// 'loading' during `update()`.
// 🔒 `/legal/*` stays readable: the attributions are a licence obligation and
// must render for everyone, whatever their account's state.
export function UsernameGate({ children }: { children: React.ReactNode }) {
  const { data } = useSession()
  const pathname = usePathname()
  if (data?.user && data.user.username === null && !pathname?.startsWith('/legal/')) return <ChooseUsername />
  return <>{children}</>
}

function ChooseUsername() {
  const { update } = useSession()
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const checked = checkUsername(username)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!checked.ok || saving) return
    setSaving(true); setError('')
    const res = await fetch('/api/me/username', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: checked.username }),
    }).catch(() => null)
    if (res?.status === 401) { window.location.href = '/login'; return }
    // The session re-reads the name and the gate lifts.
    if (res?.ok && await update()) return
    setError(res && !res.ok ? usernameSaveError(res.status, await res.json().catch(() => ({}))) : 'Could not save the username. Try again.')
    setSaving(false)
  }

  return (
    <div className="app-bg" style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{width:'100%',maxWidth:360}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontFamily:'var(--mono)',fontSize:22,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)'}}>Verre</div>
        </div>
        <form className="lobby-card lobby-form" style={{padding:22}} onSubmit={submit}>
          <h1 style={{fontSize:18,fontWeight:800,lineHeight:1.2,marginBottom:8}}>Choose Your Username</h1>
          <p style={{fontSize:12,color:'var(--fg-dim)',lineHeight:1.5,marginBottom:18}}>This is how people find you on Verre. You can change it later.</p>
          <UsernameField value={username} onChange={v => { setUsername(v); setError('') }} error={error} checkAvailable autoFocus />
          <button className="btn-p" type="submit" disabled={!checked.ok || saving}>{saving ? 'Saving…' : 'Continue'}</button>
          <p style={{textAlign:'center',marginTop:14}}>
            <button type="button" onClick={() => { clearSessionNames(); signOut({ callbackUrl: '/login' }) }}
              style={{background:'none',border:'none',cursor:'pointer',fontFamily:'var(--mono)',fontSize:11,color:'var(--fg-dim)',textDecoration:'underline'}}>
              Sign Out
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
