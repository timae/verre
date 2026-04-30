import 'next-auth'

declare module 'next-auth' {
  interface User {
    id: string
    role: string
    pro: boolean
  }
  interface Session {
    user: User & { name: string; email: string }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    role: string
    pro: boolean
  }
}
