import { prisma } from '@/lib/prisma'
import {
  createProducer,
  createProduct,
  createVintage,
  validateYear,
  denyCatalogRef,
  CatalogValidationError,
} from '@/lib/catalogWrite'

// ── The add-flow BRANCH DISPATCHER — the five RFC branches ─────────────────
//
// Lives in lib/ rather than inside the route file for two reasons: Next.js
// rejects non-HTTP-method exports from a route module (verified — `tsc` fails
// with "Property 'mintEntries' is incompatible with index signature"), and the
// integration suite must drive the REAL dispatcher. A branch-selection defect
// (a malformed `productId` falling through branch 2 and MINTING new rows
// instead of returning 400) survived a fully-green suite precisely because
// nothing exercised this logic. `app/api/catalog/entries/route.ts` is now a
// thin auth / rate-limit / JSON wrapper around this.

type MintResult = { producerId: string; productId: string; vintageId: string | null }

export async function mintEntries(body: Record<string, unknown>, userId: number): Promise<MintResult> {
  // `year` is read THREE ways and the distinction is load-bearing (see header):
  //   absent  → link at product grain, no vintage row
  //   null    → the NV row
  //   number  → that vintage
  const hasYear = 'year' in body
  const rawYear = body.year
  if (hasYear && rawYear !== null && typeof rawYear !== 'number') {
    throw new CatalogValidationError('year must be a number or null')
  }
  const year = hasYear ? validateYear((rawYear as number | null) ?? null) : undefined

  // 🔒 REJECT MALFORMED IDs BEFORE BRANCH SELECTION, not by skipping them.
  //
  // The branches key on "is this a non-empty string", so a PRESENT-but-
  // malformed id silently failed the test and fell THROUGH to a different
  // branch: `{ productId: 123, producer: {…}, product: {…} }` skipped branch 2
  // (link a vintage to this product) and instead MINTED a brand-new producer
  // and product. A client bug therefore created duplicate catalog identity
  // instead of getting a 400 — and catalog rows are permanent (one ID for
  // life), so the duplicate has to be merged away by a curator afterwards.
  //
  // Same class as the `resolveCatalogLink` type coercion: a present field with
  // the wrong type is an error, never an omission.
  for (const field of ['productId', 'producerId'] as const) {
    const v = body[field]
    if (v !== undefined && (typeof v !== 'string' || !v)) {
      throw new CatalogValidationError(`${field} must be a non-empty string when present`)
    }
  }
  // 🔒 Likewise the collaborator list: silently FILTERING malformed entries
  // meant a caller asking for three collaborators could get a product with one
  // and no indication the other two were dropped. A collaboration's producer
  // set is identity (the merge-suggestion rule compares the COMPLETE effective
  // producer set), so a silently-shrunk set is a wrong entry, not a partial one.
  if (body.collaboratorIds !== undefined && !Array.isArray(body.collaboratorIds)) {
    throw new CatalogValidationError('collaboratorIds must be an array')
  }
  const collaboratorIds: string[] = Array.isArray(body.collaboratorIds) ? body.collaboratorIds : []
  if (collaboratorIds.some(v => typeof v !== 'string' || !v)) {
    throw new CatalogValidationError('collaboratorIds must all be non-empty strings')
  }

  // ── Branch 2: existing product, missing vintage ──────────────────────────
  // No new product or producer. The vintage is minted directly under the
  // chosen product (RFC § Vintage curation is lightweight) — the
  // (product_id, year) UNIQUE NULLS NOT DISTINCT constraint is what prevents
  // duplicates at this grain, including a second NV row.
  if (typeof body.productId === 'string' && body.productId) {
    if (!hasYear) {
      throw new CatalogValidationError('year is required when adding a vintage to a product')
    }
    const product = await prisma.wineProduct.findUnique({
      where: { id: body.productId },
      select: {
        id: true,
        status: true,
        scope: true,
        producers: { where: { role: 'lead' }, select: { producerId: true } },
      },
    })
    if (!product) throw denyCatalogRef(`unknown productId ${body.productId}`)
    // Minting a child under a tombstone or a junk verdict would attach new data
    // to an entry that has already been merged away or removed from the public
    // catalog. Both resolve badly forever after.
    if (product.status === 'linked' || product.status === 'rejected') {
      throw denyCatalogRef(`product is ${product.status}, cannot take new vintages`)
    }
    if (product.scope !== 'shared') throw denyCatalogRef(`product scope is ${product.scope}`)
    // Surfacing the existing row rather than raising is deliberate: two tasters
    // adding the same vintage concurrently is an ordinary race, not an error,
    // and both should end up linked to the same row. This is NOT find-or-create
    // on a fuzzy match — the caller explicitly chose this product and this
    // exact year, so there is no identity judgement being made, and
    // (product_id, year) UNIQUE NULLS NOT DISTINCT means exactly one row can
    // satisfy it.
    //
    // Wrapped in a transaction for two reasons. First, the read and the write
    // are otherwise a check-then-act: two concurrent adds of the same year both
    // see "absent" and the loser gets a 23505 → 500, when the correct answer is
    // "you're both linked to the same row" (handled by the catch below).
    // Second, 🔒 phase 4 requires every catalog mutation to append its journal
    // event IN THE SAME TRANSACTION as the domain change — a mint that runs
    // outside one cannot honour that, so no mint here is left transaction-less.
    const vintage = await prisma.$transaction(async tx => {
      const existing = await tx.wineVintage.findFirst({
        where: { productId: product.id, year: year ?? null },
        select: { id: true },
      })
      if (existing) return existing
      return createVintage(product.id, year ?? null, userId, null, tx)
    }).catch(async err => {
      // Lost the race: the other writer committed our exact (product, year)
      // between the read and the insert. Their row IS the right answer, so
      // re-read it rather than surfacing a 500.
      if (err?.code !== 'P2002') throw err
      const row = await prisma.wineVintage.findFirst({
        where: { productId: product.id, year: year ?? null },
        select: { id: true },
      })
      if (!row) throw err
      return row
    })
    return {
      producerId: product.producers[0]?.producerId ?? '',
      productId: product.id,
      vintageId: vintage.id,
    }
  }

  // Branches 3 and 4 both mint a product, so both need its fields.
  const productInput = body.product
  if (!productInput || typeof productInput !== 'object' || Array.isArray(productInput)) {
    throw new CatalogValidationError('product is required')
  }
  const productFields = productInput as Record<string, unknown>
  // Captured into a typed local rather than cast at the use site: the check IS
  // the narrowing, and a cast there would silently survive the check being
  // removed later.
  const productName = productFields.name
  if (typeof productName !== 'string') {
    throw new CatalogValidationError('product name is required')
  }

  // ── Branches 3, 4 and 5 ──────────────────────────────────────────────────
  //
  // 🔒 ONE TRANSACTION for the whole mint, and not only because the product and
  // its lead link MUST commit together (the deferred trigger raises
  // `has no lead producer` at COMMIT otherwise — prisma/CLAUDE.md). It also
  // means branch 4 cannot half-apply: a producer minted with no product is an
  // orphan nobody will ever review or clean up, since the review queue's unit
  // is the producer/product grain.
  return prisma.$transaction(async tx => {
    let producerId: string

    if (typeof body.producerId === 'string' && body.producerId) {
      // Branch 3 — existing producer chosen explicitly.
      const producer = await tx.producer.findUnique({
        where: { id: body.producerId },
        select: { id: true, status: true },
      })
      if (!producer) throw denyCatalogRef(`unknown producerId ${body.producerId}`)
      if (producer.status === 'linked' || producer.status === 'rejected') {
        throw denyCatalogRef(`producer is ${producer.status}, cannot take new products`)
      }
      producerId = producer.id
    } else {
      // Branch 4 — nothing matched, so producer and product are BOTH minted
      // distinct. No lookup of the supplied name against existing producers
      // happens here, deliberately: the caller has already seen the fuzzy
      // suggestions and chosen to create anyway. Re-matching server-side would
      // override that human decision, which is auto-dedup by another name.
      const producerInput = body.producer
      if (!producerInput || typeof producerInput !== 'object' || Array.isArray(producerInput)) {
        throw new CatalogValidationError('producer or producerId is required')
      }
      const fields = producerInput as Record<string, unknown>
      if (typeof fields.name !== 'string') {
        throw new CatalogValidationError('producer name is required')
      }
      const created = await createProducer(
        {
          name: fields.name,
          country: fields.country,
          region: fields.region,
          website: fields.website,
        },
        userId,
        tx,
      )
      producerId = created.id
    }

    // Branch 5 rides here: collaboratorIds are set AT CREATION alongside the
    // lead. A collaboration is one product with 2+ producer links — not a
    // merge, and not something added afterwards.
    if (collaboratorIds.length) {
      const found = await tx.producer.findMany({
        where: { id: { in: collaboratorIds }, status: { notIn: ['linked', 'rejected'] } },
        select: { id: true },
      })
      if (found.length !== new Set(collaboratorIds).size) {
        throw denyCatalogRef('unknown or unlinkable collaborator producer')
      }
    }

    const product = await createProduct(
      {
        name: productName,
        producerId,
        category: typeof productFields.category === 'string' ? productFields.category : undefined,
        style: typeof productFields.style === 'string' ? productFields.style : null,
        // Passed through unvalidated on purpose: normalizeAbv in catalogWrite
        // is the single place that decides what a valid ABV is, and it throws
        // CatalogValidationError (→ 400) for anything else.
        abv: productFields.abv as number | null,
        grapes: productFields.grapes,
        region: productFields.region,
      },
      userId,
      collaboratorIds,
      tx,
    )

    // `year` absent → product-grain link, no vintage row (the unknown-year
    // case). Present (including null, the NV row) → mint it.
    const vintage = hasYear ? await createVintage(product.id, year ?? null, userId, null, tx) : null
    return { producerId, productId: product.id, vintageId: vintage?.id ?? null }
  })
}
