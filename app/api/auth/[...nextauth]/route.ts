import type { NextRequest } from 'next/server'
import { handlers } from '@/auth'
import { clientSessionJson } from '@/lib/clientSession'

// 🔒 The browser reads its own session from /api/auth/session (useSession, the
// SessionProvider's refetch, `update()` POSTs). The server-side session carries
// the INTERNAL integer in `user.id`; this wrapper rewrites the JSON on the way
// out (clientSession: `user.id` = the public id, no `userSessionId`), GET and
// POST alike, on the parsed body (never a text replace: `name` is
// user-supplied). Every other header is kept (a re-issued session cookie rides
// on Set-Cookie); Content-Length goes. public-user-ids § 5.
async function rewrite(req: NextRequest, res: Response): Promise<Response> {
  if (!req.nextUrl.pathname.endsWith('/api/auth/session')) return res
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers }) }
  const headers = new Headers()
  res.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-length') headers.append(k, v) })
  for (const c of res.headers.getSetCookie()) headers.append('set-cookie', c)
  return new Response(JSON.stringify(clientSessionJson(body)), { status: res.status, statusText: res.statusText, headers })
}

export const GET = async (req: NextRequest) => rewrite(req, await handlers.GET(req))
export const POST = async (req: NextRequest) => rewrite(req, await handlers.POST(req))
