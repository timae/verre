import 'next-auth'

declare module 'next-auth' {
  interface User {
    id: string
    tokenVersion: number
  }
  interface Session {
    user: { id: string; name: string; email: string; role: string; pro: boolean }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    tokenVersion: number
  }
}
