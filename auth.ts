import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { authConfig } from '@/auth.config'

// Constant-time guard against email enumeration via login timing.
// Real bcrypt-12 hash that will never match any user's password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12)

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = z.object({
          email: z.string().email(),
          password: z.string().min(8),
        }).safeParse(credentials)
        if (!parsed.success) return null

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        })

        const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH)
        if (!user || !valid) return null

        return {
          id: String(user.id),
          name: user.name,
          email: user.email,
          tokenVersion: user.tokenVersion,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Initial sign-in: persist id and tokenVersion from authorize()
      if (user) {
        token.id = user.id
        token.tokenVersion = (user as { tokenVersion?: number }).tokenVersion ?? 0
        return token
      }
      // Subsequent requests: validate tokenVersion is still current.
      // On mismatch, strip identity from the token. session() then returns a
      // session with no user, which auth() callers see as logged-out. We don't
      // return null here because Server Components can't set Set-Cookie, so a
      // null return leaves the cookie behind and causes a transient bad state
      // on the next render.
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: Number(token.id) },
          select: { tokenVersion: true },
        })
        if (!dbUser || dbUser.tokenVersion !== token.tokenVersion) {
          return {} as typeof token
        }
      }
      return token
    },
    async session({ session, token }) {
      // Token was stripped (revoked / user deleted) — return session with no user
      if (!token.id) return { ...session, user: undefined as never }
      // Fetch role/pro fresh on every session() call so changes (e.g. pro
      // upgrade) take effect immediately without requiring re-login.
      const dbUser = await prisma.user.findUnique({
        where: { id: Number(token.id) },
        select: { id: true, name: true, role: true, pro: true },
      })
      if (!dbUser) return { ...session, user: undefined as never }
      if (session.user) {
        session.user.id   = String(dbUser.id)
        session.user.name = dbUser.name
        session.user.role = dbUser.role
        session.user.pro  = dbUser.pro
      }
      return session
    },
  },
  session: { strategy: 'jwt' },
})
