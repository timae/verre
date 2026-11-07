import type { NextAuthConfig } from 'next-auth'

// Lightweight auth config — no Prisma, no bcrypt. proxy.ts builds its NextAuth
// instance from this alone (JWT presence only, never revocation); auth.ts extends it.
export const authConfig: NextAuthConfig = {
  trustHost: true,
  providers: [],
  pages: { signIn: '/login' },
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user
      const isMe = request.nextUrl.pathname.startsWith('/me')
      if (isMe && !isLoggedIn) return false
      return true
    },
  },
}
