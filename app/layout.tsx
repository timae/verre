import type { Metadata } from 'next'
import { SessionProvider } from 'next-auth/react'
import { auth } from '@/auth'
import { QueryProvider } from '@/components/QueryProvider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Verre — Wine Tasting OS',
  description: 'Shared wine tasting sessions with live ratings, flavour profiles, and print-ready export.',
  icons: { icon: '/favicon.png', apple: '/favicon.png' },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Prevent theme flash */}
        <script dangerouslySetInnerHTML={{__html:`(function(){var t=localStorage.getItem('vr_theme');if(t)document.documentElement.setAttribute('data-theme',t)})()`}} />
      </head>
      <body>
        <SessionProvider session={session}>
          <QueryProvider>
            {children}
          </QueryProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
