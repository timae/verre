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

        return { id: String(user.id), name: user.name, email: user.email, role: user.role, pro: user.pro }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id   = user.id
        token.role = (user as { role: string }).role
        token.pro  = (user as { pro: boolean }).pro
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id   = token.id as string
        session.user.role = token.role as string
        session.user.pro  = token.pro as boolean
      }
      return session
    },
  },
  session: { strategy: 'jwt' },
})
