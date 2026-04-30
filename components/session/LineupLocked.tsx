'use client'
import { useState, useEffect } from 'react'

function pad(n: number) { return String(n).padStart(2, '0') }

function formatDate(dt: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSecs = Math.floor(ms / 1000)
  const hours = Math.floor(totalSecs / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)
  const secs  = totalSecs % 60
  if (hours > 0) return `${pad(hours)}:${pad(mins)}:${pad(secs)}`
  return `${pad(mins)}:${pad(secs)}`
}

interface Props { revealAt: Date; onReveal?: () => void }

export function LineupLocked({ revealAt, onReveal }: Props) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= revealAt.getTime()) {
        clearInterval(t)
        onReveal?.()
      }
    }, 1000)
    return () => clearInterval(t)
  }, [revealAt.getTime()])

  const msLeft = revealAt.getTime() - now
  const countdown = formatCountdown(msLeft)

  return (
    <div style={{textAlign:'center',padding:'64px 0',color:'var(--fg-dim)'}}>
      <div style={{fontSize:36,marginBottom:12}}>🔒</div>
      <div style={{fontSize:'var(--fs-heading)',fontWeight:700,color:'var(--fg)',marginBottom:6}}>Something good awaits you.</div>
      {msLeft > 0 ? (
        <div style={{fontFamily:'var(--mono)',fontSize:28,fontWeight:700,color:'var(--accent)',letterSpacing:'0.08em',marginBottom:6}}>{countdown}</div>
      ) : null}
      <div style={{fontSize:11,color:'var(--fg-faint)'}}>Lineup revealed at {formatDate(revealAt.toISOString())}</div>
    </div>
  )
}
