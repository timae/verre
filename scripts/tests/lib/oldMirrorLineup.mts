// The PREVIOUS release's line-up mirror, copied VERBATIM from `main` (89fde50,
// lib/session.ts upsertLineup + mirrorLineup) for the rolling-deploy test of
// catalogue model change step 3 (build plan, "an old instance's strict
// mirrorLineup (rate, bookmark) over a new-projected blob must change no row").
// Never edit the statements: the point is that the OLD text, run over a line-up
// the NEW code projected, writes nothing.
import { Prisma } from '@prisma/client'

type WineMeta = {
  id: string; name: string; producer: string; vintage: string; grape: string; type: string; image: string; imageUrl: string
  description?: string; region?: string; country?: string; vinification?: string; purchaseUrl?: string
  revealedAt?: string | null; addedByIdentityId?: string; addedByDisplayName?: string; productId?: string | null; vintageId?: string | null
}

export async function oldUpsertLineup(tx: Prisma.TransactionClient, sessionId: number, wines: WineMeta[]) {
  if (wines.length === 0) return
  const adderIds = [...new Set(wines.map(w => w.addedByIdentityId).filter((id): id is string => !!id && /^u:\d{1,18}$/.test(id)).map(id => Number(id.slice(2))))]
  const liveAdders = new Set<string>()
  if (adderIds.length > 0) {
    const live = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${adderIds}::bigint[]) FOR KEY SHARE`
    for (const r of live) liveAdders.add(`u:${r.id}`)
  }
  const provenance = (w: WineMeta): [string | null, string | null] =>
    w.addedByIdentityId?.startsWith('u:') && !liveAdders.has(w.addedByIdentityId)
      ? [null, '[deleted]']
      : [w.addedByIdentityId ?? null, w.addedByDisplayName?.slice(0, 64) ?? null]
  // Clamped to the column widths: one statement writes the whole lineup, so a
  // single over-long field (the add path does not cap name / producer / grape)
  // must not fail the mirror for every wine of the session.
  const cut = (v: string | undefined, n: number) => (v ? v.slice(0, n) : null)
  const rows = wines.map((w, i) => Prisma.sql`(
    ${w.id}, ${sessionId}, ${w.name.slice(0, 255)}, ${cut(w.producer, 255)}, ${cut(w.vintage, 4)}, ${cut(w.grape, 255)},
    ${cut(w.type, 64)}, ${w.imageUrl || null}, ${cut(w.description, 1000)}, ${cut(w.region, 255)},
    ${cut(w.country, 2)}, ${cut(w.vinification, 1000)}, ${cut(w.purchaseUrl, 1000)},
    ${w.revealedAt ? new Date(w.revealedAt) : null}::timestamptz,
    ${provenance(w)[0]}, ${provenance(w)[1]},
    ${w.productId || null}, ${w.vintageId || null}, ${i}::int)`)
  await tx.$executeRaw`
    INSERT INTO wines (id, session_id, name, producer, vintage, grape, style, image_url, description, region,
                       country, vinification, purchase_url, revealed_at, added_by_identity_id,
                       added_by_display_name, product_id, vintage_id, position)
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, producer = EXCLUDED.producer, vintage = EXCLUDED.vintage,
      grape = EXCLUDED.grape, style = EXCLUDED.style, image_url = EXCLUDED.image_url,
      description = EXCLUDED.description, region = EXCLUDED.region, country = EXCLUDED.country,
      vinification = EXCLUDED.vinification, purchase_url = EXCLUDED.purchase_url,
      revealed_at = EXCLUDED.revealed_at, product_id = EXCLUDED.product_id,
      vintage_id = EXCLUDED.vintage_id, position = EXCLUDED.position
    WHERE wines.session_id = EXCLUDED.session_id
      AND (wines.name, wines.producer, wines.vintage, wines.grape, wines.style, wines.image_url,
           wines.description, wines.region, wines.country, wines.vinification, wines.purchase_url,
           wines.revealed_at, wines.product_id, wines.vintage_id, wines.position)
          IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.producer, EXCLUDED.vintage, EXCLUDED.grape, EXCLUDED.style,
           EXCLUDED.image_url, EXCLUDED.description, EXCLUDED.region, EXCLUDED.country,
           EXCLUDED.vinification, EXCLUDED.purchase_url, EXCLUDED.revealed_at, EXCLUDED.product_id,
           EXCLUDED.vintage_id, EXCLUDED.position)`
}

export async function oldMirrorLineup(tx: Prisma.TransactionClient, sessionId: number | null, wines: WineMeta[], opts: { deletedId?: string } = {}): Promise<void> {
  if (sessionId === null) return
  if (opts.deletedId) await tx.$executeRaw`DELETE FROM wines WHERE id = ${opts.deletedId} AND session_id = ${sessionId}`
  await oldUpsertLineup(tx, sessionId, wines)
  await tx.$executeRaw`
    UPDATE wines w SET position = ${wines.length}::int + o.rank - 1
      FROM (SELECT id, row_number() OVER (ORDER BY position NULLS LAST, created_at, id) AS rank
              FROM wines WHERE session_id = ${sessionId} AND NOT (id = ANY(${wines.map(x => x.id)}::text[]))) o
     WHERE w.id = o.id AND w.position IS DISTINCT FROM ${wines.length}::int + o.rank - 1`
}
