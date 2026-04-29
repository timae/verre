'use client'
import { signOut } from 'next-auth/react'

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      style={{
        fontFamily:'var(--mono)',fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',
        color:'var(--fg-faint)',background:'transparent',border:'1px solid var(--border)',
        borderRadius:3,padding:'4px 8px',cursor:'pointer',transition:'color .15s,border-color .15s',
      }}
      onMouseEnter={e => { (e.target as HTMLElement).style.color='var(--fg-dim)'; (e.target as HTMLElement).style.borderColor='var(--border2)' }}
      onMouseLeave={e => { (e.target as HTMLElement).style.color='var(--fg-faint)'; (e.target as HTMLElement).style.borderColor='var(--border)' }}
    >
      sign out
    </button>
  )
}
