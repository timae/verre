// `@name` under a person's name: regular weight, secondary ink, one line,
// cut with an ellipsis. No username yet (null) renders nothing.
export function UsernameLine({ username }: { username?: string | null }) {
  if (!username) return null
  return (
    <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--fg-dim)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{username}</div>
  )
}
