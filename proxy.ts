import NextAuth from 'next-auth'
import { authConfig } from '@/auth.config'

// The lightweight instance from auth.config.ts (JWT presence only), NOT the
// full auth.ts: its jwt() callback hits Postgres for the revocation gate, and
// the proxy runs on the Node runtime, so importing it here would succeed and
// silently move DB work in front of every /me request.
export const proxy = NextAuth(authConfig).auth

export const config = {
  matcher: ['/me/:path*'],
}
