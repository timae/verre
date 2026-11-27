import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { normalizePublicUserId } from '@verre/core'
import { momentLookInEnabled } from '@/lib/momentGate'
import { APP_LINK_SCHEME } from '@/lib/momentLink'

// The look-in link's landing page (Moment Visibility step-2 plan § 5, R12).
// There are no app links (nothing registered with Apple or Google), so the
// shared https link opens this page, whose one button hands the same link to
// the app over its own address (`io.verre.app://l/<id>.<token>`); the app opens
// the look-in. 🔒 The page reads NOTHING: no database, no Redis, no moment
// name; the only thing it takes from the URL is the button's href, rebuilt
// from the parsed parts (T11), never echoed. Flag off → 404 (a switched-off
// surface). Headers (next.config.ts, the `/l/:path*` entry): no-referrer,
// private no-store, noindex. Pinned against the built server:
// scripts/tests/moment-link-web.mts.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Verre', robots: { index: false, follow: false } }

const LINK = /^([0-9a-z]{12})\.([0-9a-f]{32})$/i

export default async function LookInLinkPage({ params }: { params: Promise<{ link: string }> }) {
  if (!momentLookInEnabled()) notFound()
  const m = LINK.exec((await params).link)
  const id = m ? normalizePublicUserId(m[1]) : null
  const href = m && id ? `${APP_LINK_SCHEME}://l/${id.toLowerCase()}.${m[2].toLowerCase()}` : null
  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: '96px 24px', textAlign: 'center' }}>
      {href ? (
        <>
          <h1 style={{ fontSize: 26, color: 'var(--fg)', marginBottom: 12 }}>Before you continue</h1>
          <p style={{ color: 'var(--fg-warm)', lineHeight: 1.6, marginBottom: 32 }}>You&apos;ll need a phone with the app installed.</p>
          <a
            href={href}
            style={{ display: 'inline-block', background: 'var(--accent)', color: 'var(--bg)', borderRadius: 999, padding: '14px 28px', fontWeight: 600, textDecoration: 'none' }}
          >
            Open in Verre
          </a>
        </>
      ) : (
        <h1 style={{ fontSize: 26, color: 'var(--fg)' }}>This link doesn&apos;t work</h1>
      )}
    </main>
  )
}
