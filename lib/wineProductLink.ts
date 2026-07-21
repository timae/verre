import { Prisma, PrismaClient } from '@prisma/client'
import { nanoid } from 'nanoid'
import { wineMatchKey, hasLinkableName } from './wineProductKey'

// Find-or-create the canonical wine_products row for a wine and return its id
// (or null when the wine has no linkable name — mirrors the backfill guard).
//
// This is the ONLY runtime writer of wine_products. It runs at the
// Postgres-write boundary (pgUpsertWine / pgReassignWineProvenance create +
// the checkins txn) — never on the Redis/live-session path — so productId
// stays out of WireWine/WineMeta and can't leak through redactWine.
//
// Implemented as a raw INSERT ... ON CONFLICT (match_key) so it is:
//   1. Race-safe — two concurrent wines with the same key can't both insert;
//      the loser takes the DO UPDATE branch and RETURNING yields the existing
//      id. (Prisma's upsert() on a unique field is NOT concurrency-safe here.)
//   2. Fill-nulls accretion — the product monotonically accretes best-known
//      editorial metadata: only currently-NULL columns are filled from the new
//      wine (COALESCE(existing, incoming)); non-null fields are never
//      overwritten. Prisma's typed update can't express COALESCE, hence raw.
//
// category/style are DELIBERATELY set only on first insert and never touched by
// DO UPDATE: the composite FK (category, style) → category_styles must stay a
// valid PAIR, and COALESCE-ing them independently could splice a category from
// one wine with a style from another into an invalid pair.
type Db = PrismaClient | Prisma.TransactionClient

export type LinkableWineFields = {
  name: string
  producer?: string | null
  vintage?: string | null
  grape?: string | null
  category?: string | null
  style?: string | null
  region?: string | null
  country?: string | null
  vinification?: string | null
  description?: string | null
  imageUrl?: string | null
}

export async function linkWineToProduct(db: Db, w: LinkableWineFields): Promise<string | null> {
  if (!hasLinkableName(w.name)) return null
  const matchKey = wineMatchKey(w.producer, w.name, w.vintage)
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "wine_products"
      (id, match_key, name, producer, vintage, grape, category, style, region, country, vinification, description, image_url, created_at, updated_at)
    VALUES (
      ${nanoid()}, ${matchKey}, ${w.name}, ${w.producer ?? null}, ${w.vintage ?? null}, ${w.grape ?? null},
      ${w.category ?? 'wine'}, ${w.style ?? null}, ${w.region ?? null}, ${w.country ?? null},
      ${w.vinification ?? null}, ${w.description ?? null}, ${w.imageUrl ?? null}, now(), now()
    )
    ON CONFLICT (match_key) DO UPDATE SET
      grape        = COALESCE("wine_products".grape, EXCLUDED.grape),
      region       = COALESCE("wine_products".region, EXCLUDED.region),
      country      = COALESCE("wine_products".country, EXCLUDED.country),
      vinification = COALESCE("wine_products".vinification, EXCLUDED.vinification),
      description  = COALESCE("wine_products".description, EXCLUDED.description),
      image_url    = COALESCE("wine_products".image_url, EXCLUDED.image_url),
      updated_at   = now()
    RETURNING id
  `)
  return rows[0]?.id ?? null
}
