'use client'
import { useState, useEffect } from 'react'

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark'|'light'>('dark')

  useEffect(() => {
    const saved = localStorage.getItem('vr_theme') as 'dark'|'light' || 'dark'
    setTheme(saved)
    document.documentElement.setAttribute('data-theme', saved)
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('vr_theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  return (
    <button onClick={toggle} aria-label="Toggle color theme" style={{
      width:34,height:34,display:'flex',alignItems:'center',justifyContent:'center',
      border:'1px solid var(--border)',borderRadius:10,background:'var(--bg2)',
      color:'var(--fg-dim)',cursor:'pointer',fontSize:15,lineHeight:1,
      fontFamily:'var(--mono)',flexShrink:0,
    }}>
      {theme === 'light' ? '☀' : '◐'}
    </button>
  )
}
