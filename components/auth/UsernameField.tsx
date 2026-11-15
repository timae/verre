'use client'
import { useEffect, useState } from 'react'
import { USERNAME_MAX, checkUsername, type UsernameCheck } from '@verre/core'

export const USERNAME_TAKEN = 'This username is taken.'
const RESERVED = 'This username is reserved.'
const PAUSE_MS = 500

// A lowercase message ("username must be at least 3 characters") as a sentence.
export function sentence(s: string): string {
  const t = s.trim()
  if (!t) return t
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.')
}

// The rule a typed username breaks, as shown under the field.
export function usernameProblem(c: Extract<UsernameCheck, { ok: false }>): string {
  return c.reason === 'reserved' ? RESERVED : sentence(c.message)
}

// A PUT /api/me/username refusal as the line under the field (409 taken, a 400
// with the rule, a 429 with the server's wait).
export function usernameSaveError(status: number, body: { error?: string; code?: string }): string {
  if (status === 409 && body.code === 'taken') return USERNAME_TAKEN
  if (body.code === 'reserved') return RESERVED
  return body.error ? sentence(body.error) : 'Could not save the username. Try again.'
}

interface Props {
  value: string
  onChange: (v: string) => void
  // The caller's own answer (a submit's refusal). Wins over the live check.
  error?: string
  // Ask GET /api/me/username/available after the pause (signed in only).
  checkAvailable?: boolean
  // The caller's current username: never checked, never "taken".
  current?: string | null
  disabled?: boolean
  autoFocus?: boolean
}

// The Username input with its `@` prefix and the live check: the broken rule
// about 500 ms after the last keystroke, gone as soon as it is fixed, then
// (optionally) the availability answer. 🔒 autoComplete is "off", never
// "username": the EMAIL is the login a password manager must save.
export function UsernameField({ value, onChange, error, checkAvailable, current, disabled, autoFocus }: Props) {
  const [settled, setSettled] = useState(value)
  const [answer, setAnswer] = useState<{ name: string; available: boolean; reason?: string } | null>(null)
  const [focused, setFocused] = useState(false)
  const checked = checkUsername(value)
  const paused = settled === value
  const asked = checkAvailable && checked.ok && checked.username !== current ? checked.username : null

  useEffect(() => {
    const t = setTimeout(() => setSettled(value), PAUSE_MS)
    return () => clearTimeout(t)
  }, [value])

  // Only the answer for the text now in the field counts: each answer carries
  // its name, and a superseded request is aborted.
  useEffect(() => {
    if (!paused || asked === null) return
    const ctl = new AbortController()
    fetch(`/api/me/username/available?username=${encodeURIComponent(asked)}`, { cache: 'no-store', signal: ctl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && typeof d.available === 'boolean') setAnswer({ name: asked, available: d.available, reason: d.reason }) })
      .catch(() => {})
    return () => ctl.abort()
  }, [paused, asked])

  const live = paused && asked !== null && answer?.name === asked ? answer : null
  const problem = error
    || (paused && value !== '' && !checked.ok ? usernameProblem(checked) : '')
    || (live && !live.available ? (live.reason === 'reserved' ? RESERVED : USERNAME_TAKEN) : '')

  return (
    <div className="field">
      <div className="fl">username</div>
      {/* The border inline: the light theme's `.fi` rule outranks `.fi.error`. */}
      <div className="fi"
        style={{display:'flex',alignItems:'center',gap:2,opacity:disabled?0.5:1,...(problem ? {borderColor:'var(--danger)'} : focused ? {borderColor:'var(--accent2)'} : {})}}>
        <span aria-hidden="true" style={{color:'var(--fg-dim)'}}>@</span>
        <input type="text" value={value} disabled={disabled} autoFocus={autoFocus} aria-label="Username"
          onChange={e => {
            // Typing on drops the last answer (it must not reappear for the same
            // text before it is re-checked). The app's rule: every leading `@`
            // off, ASCII lowercased, 30 kept (apps/mobile lib/usernameCopy.ts).
            setAnswer(null)
            onChange(e.target.value.replace(/^\s*@+/, '').replace(/[A-Z]/g, c => c.toLowerCase()).slice(0, USERNAME_MAX))
          }}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          style={{flex:1,minWidth:0,background:'transparent',border:'none',outline:'none',padding:0,font:'inherit',color:'inherit'}} />
      </div>
      {problem
        ? <div role="alert" style={{fontSize:11,color:'var(--danger)',marginTop:6}}>{problem}</div>
        : live?.available && <div style={{fontSize:11,color:'var(--accent2)',marginTop:6}}>Available</div>}
    </div>
  )
}
