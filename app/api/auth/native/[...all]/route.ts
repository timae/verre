import { toNextJsHandler } from 'better-auth/next-js'
import { betterAuthServer } from '@/lib/betterAuth'

// Better Auth's catch-all, mounted under /api/auth/native so it never collides
// with NextAuth's [...nextauth] catch-all (Next.js forbids two catch-alls at one
// path level). betterAuthServer pulls node:* + bcrypt, so this route is pinned to
// the Node runtime — never Edge (proposal §6.9; the middleware matcher /me/:path*
// already excludes /api/auth/*, so NextAuth's Edge config won't run here either).
export const runtime = 'nodejs'

export const { GET, POST } = toNextJsHandler(betterAuthServer)
