import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getProductAggregate } from '@/lib/productAggregate'

// Public wine product page data — canonical identity + editorial metadata +
// the community rating aggregate. Distinct from the session-scoped
// /api/session/[code]/wines. Look up by the product's nanoid; unknown → 404
// (products are public reference data, so no enumeration-oracle masking).
//
// CACHING: this response is VIEWER-INDEPENDENT (aggregate only, no per-viewer
// fields) — the deliberate inverse of the app/api/CLAUDE.md `private, no-store`
// rule, which governs viewer-DEPENDENT responses. Shared CDN caching is safe
// and desirable here. ⚠️ If a viewer-scoped field is ever added (bookmark
// state, "who tasted it" gated by profile visibility), this MUST flip to
// `private, no-store` or split the viewer part into a separate authed request.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params

  const product = await prisma.wineProduct.findUnique({
    where: { id: productId },
    select: {
      id: true, name: true, producer: true, vintage: true, grape: true,
      category: true, style: true, region: true, country: true,
      vinification: true, description: true,
    },
  })
  if (!product) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // imageUrl is DERIVED from live constituent wines (not a pinned column), so a
  // reclaimed/replaced source image can't leave a broken product image.
  const { imageUrl, community } = await getProductAggregate(product.id)

  return NextResponse.json({
    id: product.id,
    name: product.name,
    producer: product.producer,
    vintage: product.vintage,
    grape: product.grape,
    category: product.category,
    // `type` matches the WineIdentity / feed vocabulary for the style column.
    type: product.style,
    // Raw ISO 3166-1 alpha-2; the client resolves it to a name via
    // @verre/core countryName (matches the feed + WineInfoPane).
    country: product.country,
    region: product.region,
    vinification: product.vinification,
    description: product.description,
    imageUrl,
    community,
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  })
}
