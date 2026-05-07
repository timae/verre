import type { Metadata, Viewport } from 'next'
import { SessionProvider } from 'next-auth/react'
import { auth } from '@/auth'
import { QueryProvider } from '@/components/QueryProvider'
import { ImageLightbox } from '@/components/ui/ImageLightbox'
import './globals.css'

export const metadata: Metadata = {
  title: 'Verre — Wine Tasting OS',
  description: 'Shared wine tasting sessions with live ratings, flavour profiles, and print-ready export.',
  icons: { icon: '/favicon.png', apple: '/favicon.png' },
}

// Viewport config — without this, mobile browsers default to a desktop-
// width viewport and scale the page down to fit, which makes Verre
// render tiny on phones until the user pinch-zooms. width=device-width
// + initial-scale=1 makes the page render at the device's actual width.
//
// Deliberately NOT setting maximumScale or userScalable: false. Pinch-
// zoom is an accessibility feature for low-vision users (WCAG 1.4.4).
// The iOS auto-zoom-on-input-focus problem is solved instead by the
// 16px mobile input font rule in globals.css — iOS only triggers the
// zoom when the input font-size is below that threshold.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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
            <ImageLightbox />
          </QueryProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
