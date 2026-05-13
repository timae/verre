// Session-scoped role chip rendered in the user-menu identity block.
// Color/style mirrors the participants-list role badges in SessionPanel
// for visual consistency:
//   host     → accent gold
//   co-host  → accent2 green
//   provider → cool blue
// Tasters get no badge (null → renders nothing).
export function RoleBadge({ role }: { role: 'host' | 'co-host' | 'provider' | null }) {
  if (!role) return null
  const style: React.CSSProperties = {
    fontSize: 9,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    padding: '1px 5px',
    borderRadius: 2,
    border: '1px solid',
    flexShrink: 0,
  }
  if (role === 'host') {
    return <span style={{ ...style, color: 'var(--accent)', borderColor: 'rgba(200,150,60,0.3)' }}>host</span>
  }
  if (role === 'co-host') {
    return <span style={{ ...style, color: 'var(--accent2)', borderColor: 'rgba(143,184,122,0.3)' }}>co-host</span>
  }
  return <span style={{ ...style, color: 'var(--accent-provider)', borderColor: 'rgba(120,180,220,0.35)' }}>provider</span>
}
