'use client'

function formatDate(dt: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

interface Props { revealAt: Date }

export function LineupLocked({ revealAt }: Props) {
  return (
    <div style={{textAlign:'center',padding:'64px 0',color:'var(--fg-dim)'}}>
      <div style={{fontSize:36,marginBottom:12}}>🔒</div>
      <div style={{fontSize:'var(--fs-heading)',fontWeight:700,color:'var(--fg)',marginBottom:6}}>Something good awaits you.</div>
      <div style={{fontSize:11,color:'var(--fg-faint)'}}>Lineup revealed at {formatDate(revealAt.toISOString())}</div>
    </div>
  )
}
