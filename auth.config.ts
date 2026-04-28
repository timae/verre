import type { NextAuthConfig } from 'next-auth'

// Edge-compatible auth config — no Prisma, no bcrypt
// Used only by middleware.ts (Edge Runtime)
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
