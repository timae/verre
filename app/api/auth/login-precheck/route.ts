// Login precheck — peeks at the rate-limit counters without incrementing,
// so the login form can show a friendly "try again in N seconds" message
// before calling signIn(). NextAuth v5 strips custom error messages out
// of signIn()'s response, so we can't rely on the server-throws-an-Error
// path alone for a user-visible countdown.
//
// This endpoint reveals nothing useful: it doesn't say whether the email
// exists, only whether THIS email/IP combination is currently being
// throttled. An attacker already knows their own throttle state.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { peekRates, getClientIp } from '@/lib/rateLimit'

const schema = z.object({ email: z.string().email() })

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ allowed: true })

  const email = parsed.data.email.toLowerCase()
  const ip = getClientIp(req)

  const rate = await peekRates([
    { key: `rl:login:email:${email}:1m`, max: 10, windowSeconds: 60 },
    { key: `rl:login:email:${email}:1h`, max: 20, windowSeconds: 3600 },
    { key: `rl:login:ip:${ip}:10m`,      max: 100, windowSeconds: 600 },
  ])

  return NextResponse.json({
    allowed: rate.allowed,
    retryAfter: rate.retryAfter,
  })
}
