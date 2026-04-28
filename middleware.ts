import { auth } from '@/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const isLoggedIn = !!req.auth
  const isMe = req.nextUrl.pathname.startsWith('/me')

  if (isMe && !isLoggedIn) {
    return NextResponse.redirect(new URL('/login', req.nextUrl))
  }
})

export const config = {
  matcher: ['/me/:path*'],
}
