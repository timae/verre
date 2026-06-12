import type { NextRequest } from 'next/server'
import { toNextJsHandler } from 'better-auth/next-js'
import { betterAuthServer } from '@/lib/betterAuth'
import { clientVersionGate } from '@/lib/clientVersion'

// Better Auth's catch-all, mounted under /api/auth/native so it never collides
// with NextAuth's [...nextauth] catch-all (Next.js forbids two catch-alls at one
// path level). betterAuthServer pulls node:* + bcrypt, so this route is pinned to
// the Node runtime — never Edge (proposal §6.9; the middleware matcher /me/:path*
// already excludes /api/auth/*, so NextAuth's Edge config won't run here either).
export const runtime = 'nodejs'

const handlers = toNextJsHandler(betterAuthServer)

// X-Verre-Client min-version gate (proposal 04, lib/clientVersion.ts). This
// route is the chokepoint every native session resolution passes through
// (sign-in/up + the SDK's /get-session heartbeat), so gating here is what puts
// a below-floor client on the blocking update screen. Runs BEFORE Better Auth
// so a stale client can't sign in past the floor. Inert while the floor envs
// are unset; never fires for web (no header).
export const GET = async (req: NextRequest) => clientVersionGate(req) ?? handlers.GET(req)
export const POST = async (req: NextRequest) => clientVersionGate(req) ?? handlers.POST(req)
