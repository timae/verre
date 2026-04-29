'use client'
import { useState, useRef, useEffect } from 'react'
import { signOut } from 'next-auth/react'
import Link from 'next/link'

interface Props {
  name: string
  email: string
  pro: boolean
}

export function UserMenu({ name, email, pro }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  return (
    <div ref={ref} style={{position:'relative'}}>
      <button
        onClick={() => setOpen(!open)}
        style={{display:'flex',alignItems:'center',gap:6,fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.06em',color:'var(--fg-dim)',border:'1px solid var(--border)',background:'var(--bg2)',padding:'5px 10px',borderRadius:3,cursor:'pointer',transition:'border-color .15s,color .15s'}}
      >
        <div style={{width:6,height:6,borderRadius:'50%',background: pro ? 'var(--accent)' : 'var(--accent2)',flexShrink:0}} />
        {name}
        {pro && <span style={{fontSize:8,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',padding:'1px 4px',borderRadius:2}}>pro</span>}
        <span style={{fontSize:8,color:'var(--fg-faint)',marginLeft:2}}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',width:200,background:'var(--bg2)',border:'1px solid var(--border2)',borderRadius:10,overflow:'hidden',boxShadow:'0 12px 40px rgba(0,0,0,0.4)',zIndex:100}}>
          {/* Account info */}
          <div style={{padding:'10px 12px',borderBottom:'1px solid var(--border)'}}>
            <div style={{fontSize:12,fontWeight:700,color:'var(--fg)'}}>{name}</div>
            <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:1}}>{email}</div>
            {pro && <div style={{fontSize:9,color:'var(--accent)',marginTop:3,letterSpacing:'0.06em',textTransform:'uppercase'}}>✦ Pro account</div>}
          </div>

          {/* Links */}
          {[
            { href: '/me/profile', label: '◉  Profile & settings' },
            { href: '/me/badges',  label: '🏅  Badges & XP' },
            { href: '/me/history', label: '◷  Tasting history' },
          ].map(({ href, label }) => (
            <Link key={href} href={href} onClick={() => setOpen(false)}
              style={{display:'block',padding:'9px 12px',fontSize:11,color:'var(--fg-dim)',textDecoration:'none',fontFamily:'var(--mono)',letterSpacing:'0.04em',borderBottom:'1px solid var(--border)',transition:'background .12s,color .12s'}}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {label}
            </Link>
          ))}

          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            style={{display:'block',width:'100%',textAlign:'left',padding:'9px 12px',fontSize:11,color:'rgba(184,64,64,0.7)',fontFamily:'var(--mono)',letterSpacing:'0.04em',background:'none',border:'none',cursor:'pointer',transition:'color .12s'}}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(184,64,64,1)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(184,64,64,0.7)')}
          >
            ↩  Sign out
          </button>
        </div>
      )}
    </div>
  )
}
