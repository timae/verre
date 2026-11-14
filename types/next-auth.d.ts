import 'next-auth'

declare module 'next-auth' {
  interface User {
    id: string
    // Per-device session row id (uuid), minted in authorize() and carried in
    // the signed JWT. The auth.ts revalidation gate looks up its revokedAt.
    userSessionId?: string
  }
  interface Session {
    // Server-side `id` is the INTERNAL integer (as a string); `publicId` is the
    // public id. 🔒 A client only ever receives clientSession(session)
    // (lib/clientSession.ts), whose user.id IS the public id.
    // `username`: null = not chosen yet (usernames § 10). Fresh on both
    // branches of resolveUser (auth.ts session(), the native SELECT).
    user: { id: string; name: string; username?: string | null; email: string; role: string; pro: boolean; userSessionId?: string; publicId?: string }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    // Present on every token minted after the per-device-sessions feature
    // shipped. A token WITHOUT it is a pre-feature ("legacy") JWT — the auth.ts
    // revalidation gate treats that as invalid and strips identity (forced
    // re-login on the next request). Optional only because the type is shared
    // with that transient legacy case; a live session always carries one.
    userSessionId?: string
  }
}
