import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getProductAggregate } from '@/lib/productAggregate'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { StarRating } from '@/components/ui/StarRating'
import { ProductFlavorWheel } from '@/components/wine/ProductFlavorWheel'
import { ThemeToggle } from '@/components/ThemeToggle'
import { renderWithLinks } from '@/lib/renderWithLinks'
import { countryName, formatScore, getAromaNode } from '@verre/core'

// Public canonical wine product page. One page per real-world bottle,
// aggregating community ratings across every session + user. Reachable by
// tapping a wine name in the feed. Server-rendered off the same data path as
// GET /api/wines/[productId] (prisma + getProductAggregate) — no auth, viewer-
// independent, safe to cache.
export const dynamic = 'force-dynamic'

export default async function WineProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params
  const product = await prisma.wineProduct.findUnique({
    where: { id: productId },
    select: {
      id: true, name: true, producer: true, vintage: true, grape: true,
      category: true, style: true, region: true, country: true,
      vinification: true, description: true,
    },
  })
  if (!product) notFound()

  // imageUrl is DERIVED from live constituent wines (not a pinned column).
  const { imageUrl, community } = await getProductAggregate(product.id)
  const country = countryName(product.country)
  const origin = [product.region, country].filter(Boolean).join(', ')
  const topAromas = community.aromas
    .map(a => ({ ...a, label: getAromaNode(a.node)?.label }))
    .filter(a => a.label)
    .slice(0, 8)

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Link href="/me/feed" style={{ fontSize: 13, color: 'var(--fg-dim)', textDecoration: 'none' }}>← Feed</Link>
        <ThemeToggle />
      </header>

      {/* Identity + bottle shot */}
      <section style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{
          flex: '0 0 96px', height: 128, borderRadius: 12, background: 'var(--bg3)', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {imageUrl
            ? <img src={imageUrl} alt={product.name} style={{ width: '100%', maxHeight: 128, objectFit: 'contain' }} />
            : <span style={{ fontSize: 40, opacity: 0.25 }}>🍷</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WineIdentity wine={{ name: product.name, vintage: product.vintage, producer: product.producer, grape: product.grape }} size="hero" />
          {origin && <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 6 }}>{origin}</p>}
        </div>
      </section>

      {/* Community rating summary */}
      <section style={{
        display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, padding: '14px 16px',
        background: 'var(--bg2)', borderRadius: 12,
      }}>
        {community.avgScore != null ? (
          <>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--fg)', lineHeight: 1 }}>{formatScore(community.avgScore)}</div>
            <div style={{ minWidth: 0 }}>
              <StarRating value={community.avgScore} size="detail" />
              <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 4 }}>
                {community.ratingCount} {community.ratingCount === 1 ? 'rating' : 'ratings'}
                {community.tasterCount > 0 && <> · {community.tasterCount} {community.tasterCount === 1 ? 'person' : 'people'}</>}
              </div>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
            {community.tastingCount > 0 ? 'Tasted, not yet scored' : 'No ratings yet'}
          </div>
        )}
      </section>

      {/* Community flavour wheel */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Community flavour profile</h2>
        <ProductFlavorWheel flavors={community.flavors} type={product.style} label={product.name} />
      </section>

      {/* Top community aromas */}
      {topAromas.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Most-noted aromas</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {topAromas.map(a => (
              <span key={a.node} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, background: 'var(--bg3)', color: 'var(--fg)' }}>
                {a.label} <span style={{ color: 'var(--fg-faint)' }}>{a.count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Editorial metadata */}
      {(product.vinification || product.description) && (
        <section style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {product.description && (
            <div>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>About</h2>
              <p style={{ fontSize: 14, color: 'var(--fg)', lineHeight: 1.6 }}>{renderWithLinks(product.description)}</p>
            </div>
          )}
          {product.vinification && (
            <div>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Vinification</h2>
              <p style={{ fontSize: 14, color: 'var(--fg)', lineHeight: 1.6 }}>{renderWithLinks(product.vinification)}</p>
            </div>
          )}
        </section>
      )}
    </main>
  )
}
