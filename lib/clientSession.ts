import type { Session } from 'next-auth'

// 🔒 The ONE server → client hand-off of a NextAuth session (public-user-ids
// § 5): `user.id` becomes the PUBLIC id, and the server-only fields
// (`userSessionId`, the internal integer) are dropped. Every place a session
// leaves the server goes through this: the root layout's <SessionProvider>,
// the /me layouts and pages that pass `session.user` to client components,
// /u/[id], and the /api/auth/session route wrapper (same rewrite on the JSON).
// A session whose public id is unknown (none loaded) leaves with no user.
export type ClientSession = Omit<Session, 'user'> & {
  user?: { id: string; name: string; username: string | null; email: string; role: string; pro: boolean }
}

export function clientSession(session: Session | null | undefined): ClientSession | null {
  if (!session) return null
  const { user, ...rest } = session
  if (!user?.publicId) return { ...rest }
  return { ...rest, user: { id: user.publicId, name: user.name, username: user.username ?? null, email: user.email, role: user.role, pro: user.pro } }
}

// The same rewrite on a parsed /api/auth/session body (an object or null).
export function clientSessionJson(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  return clientSession(body as Session)
}
