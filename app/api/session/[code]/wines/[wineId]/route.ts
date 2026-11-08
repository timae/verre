import { reclaimImages } from '@/lib/engagementCascade'
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, scanKeys } from '@/lib/redis'
import { isHostByIdentity, isProvider, mutateWines, isMutateReject, addWineToSession, mirrorLineup, reassignProvenance, wineToWire, buildKickedUserNameLookup, reclaimIfUnreferenced } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable, isValidIdentityId, isTombstoneIdentityId } from '@/lib/identity'
import { deleteImage } from '@/lib/s3'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { resolveCatalogLink, applyIdentityEditRule, catalogLinkRateKey, CatalogValidationError } from '@/lib/catalogWrite'
import { withSessionMutation, admitted, refuse, bestEffortMirror, ContractCold, type MutationCtx } from '@/lib/sessionMutation'
import { readGrant, grantStatus, type AuthorizedIdentity } from '@/lib/sessionGrant'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'
import type { WineMeta } from '@/lib/session'

// A provider's own-wine check (plan § 2, G2): ownership is a privilege, so for
// a `u:` caller with a grant it is read from the RECORD
// (wines.added_by_identity_id) under the contract's locks; otherwise from the
// cached provenance — Redis is the anonymous caller's and the Redis-only
// session's authority.
async function ownsWine(tx: Prisma.TransactionClient, ctx: MutationCtx, caller: AuthorizedIdentity, wine: WineMeta): Promise<boolean> {
  if (caller.grant && ctx.row) {
    const rows = await tx.$queryRaw<{ added_by_identity_id: string | null }[]>`
      SELECT added_by_identity_id FROM wines WHERE id = ${wine.id} AND session_id = ${ctx.row.id}`
    return rows[0]?.added_by_identity_id === caller.id
  }
  return wine.addedByIdentityId === caller.id
}

// The wine as the lineup holds it NOW, under the contract's locks (an absent
// lineup is a cold cache, never "no such wine").
async function currentWine(code: string, wineId: string): Promise<WineMeta | null> {
  const raw = await redis.get(k.wines(code))
  if (raw === null) throw new ContractCold(code)
  return (JSON.parse(raw) as WineMeta[]).find(w => w.id === wineId) ?? null
}


type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const { meta, wines } = opened
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Hosts (including cohosts) can edit any wine. Providers can edit
  // only the wines they themselves added — matched via the wine's
  // `addedByIdentityId`. Wines from before the provider feature have
  // NULL provenance and aren't editable by providers.
  const isHost = isHostByIdentity(meta, identity)
  // Early reject only: the power and the ownership are re-decided under the
  // locks (fresh grant, record ownership).
  // A record-backed provider's ownership is the record's (r2 N4: cached
  // provenance can trail a committed reassign) — the contract decides it.
  const isOwnAsProvider = isProvider(meta, identity) && (!!identity.grant || wines[idx].addedByIdentityId === identity.id)
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can edit it' }, { status: 403 })
  }

  // ── Reassign "Brought by" — bounded v1 (docs/dev/proposals/reassign-brought-by.md).
  // OWNERSHIP-ONLY: a PATCH carrying broughtByIdentityId may carry nothing else,
  // so the critical section is S3-free and touches only the two provenance
  // fields. Record-first since release B (plan D2) — see reassignBroughtBy.
  if (body.broughtByIdentityId !== undefined) {
    return reassignBroughtBy({ c, wineId, body, identity, isHost, showProvenance: meta.showProvenance !== false })
  }

  // ── Catalog link on edit ─────────────────────────────────────────────────
  //
  // Two rules compose here, in this order:
  //   1. If the caller sent productId/vintageId, validate them server-side (an
  //      explicit re-link, or an explicit clear).
  //   2. Otherwise apply the identity-changing-edit rule: an edit that changes
  //      the instance's name, producer, or vintage CLEARS the link rather than
  //      silently keeping a now-incompatible one. Cosmetic edits keep it.
  //
  // 🔒 Deciding this HERE, before addWineToSession, is what makes it apply to
  // the wholesale Redis replacement below — the PATCH replaces the wine object
  // entirely, so the link that survives is exactly the one computed now.
  const sentLink = body.productId !== undefined || body.vintageId !== undefined
  // Shares the POST route's counter key EXACTLY (app/api/CLAUDE.md's
  // shared-counter pattern) so add + edit can't stack N+N against the catalog.
  // Charged only when a link is supplied — ordinary wine edits are unaffected.
  if (sentLink) {
    const rl = await checkRate(catalogLinkRateKey(identity.id, getClientIp(req)), 120, 3600)
    if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  let link: { productId: string | null; vintageId: string | null }
  let linkIsDeliberate = false
  try {
    // The stored link is passed so a PARTIAL link edit works: sending only
    // `{ vintageId: null }` ("drop to product grain") keeps the product rather
    // than destroying it, because an omitted field means KEEP.
    const explicit = sentLink
      ? await resolveCatalogLink(body.productId, body.vintageId, wines[idx])
      : null
    link = applyIdentityEditRule(wines[idx], body, explicit)
    // Did this request make a DELIBERATE decision about the link, or did the
    // rule merely resolve to "leave it alone"? Only the former may overwrite
    // what is live at write time — see the splice in the transform below.
    linkIsDeliberate = sentLink
      || link.productId !== (wines[idx].productId ?? null)
      || link.vintageId !== (wines[idx].vintageId ?? null)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  // addWineToSession may do an S3 upload — a side effect that must run
  // OUTSIDE the WATCH/MULTI transform (the transform can run multiple
  // times on retry and must stay pure). Build the result here against the
  // wine we read, then atomically splice it in by id below.
  const result = await addWineToSession(c, { ...body, ...link }, wines[idx])
  if ('error' in result) return NextResponse.json(result, { status: 400 })
  // S3 effects follow the authorized commit (r3 P1): this edit's own upload is
  // reclaimed if the write is refused; the image it replaces only after COMMIT.
  // The image this edit decides: removal (null) or a SUCCESSFUL upload. Any
  // other image input (an upload that failed, a non-data value) keeps the
  // CURRENT locked imageUrl and reclaims nothing (r4 P1-2 — the snapshot's URL
  // may already have been replaced and reclaimed by a concurrent edit).
  const uploaded = result.imageUrl && result.imageUrl !== wines[idx].imageUrl ? result.imageUrl : null
  const imageDecided = body.image === null || !!uploaded
  let replacedUrl: string | null = null
  let mirrored = false

  // The write, inside the session mutation contract. The replacement was
  // prepared before the lock (across the upload), so everything another writer
  // may have changed since is taken from the CURRENT entry inside the transform:
  // provenance (frozen on edits), the catalog link unless this edit set it
  // deliberately, and 🔒 revealedAt (r3-2 — a concurrent hide must not be undone
  // by this edit's stale copy). The lineup mirror projects the whole array.
  let written: WineMeta
  try {
    written = await withSessionMutation(c, { label: 'wine-edit', redisLock: { waitMs: 3000 }, caller: identity }, async (tx, ctx) => {
      replacedUrl = null; mirrored = false   // per attempt (r3 P1)
      const caller = admitted(ctx)
      const wine = await currentWine(c, wineId)
      if (!wine) throw refuse(404, 'wine not found')
      if (!isHostByIdentity(ctx.meta!, caller) && !(isProvider(ctx.meta!, caller) && await ownsWine(tx, ctx, caller, wine))) {
        throw refuse(403, 'only the host or the provider who added this wine can edit it')
      }
      const out = await mutateWines(ctx.fence!, (current) => {
        const i = current.findIndex(w => w.id === wineId)
        if (i === -1) return { reject: 'wine not found' }
        const next = current.slice()
        next[i] = {
          ...result,
          // An edit that did not touch the image keeps the CURRENT one (a
          // concurrent image change must not be reverted to stale bytes).
          ...(imageDecided ? {} : { imageUrl: current[i].imageUrl, ...(body.image === undefined ? { image: current[i].image } : {}) }),
          revealedAt: current[i].revealedAt ?? null,
          addedByIdentityId: current[i].addedByIdentityId,
          addedByDisplayName: current[i].addedByDisplayName,
          // An edit that made NO deliberate link decision keeps whatever link is
          // live now (a concurrent link edit must not be undone by this copy).
          ...(linkIsDeliberate
            ? { productId: link.productId, vintageId: link.vintageId }
            : { productId: current[i].productId ?? null, vintageId: current[i].vintageId ?? null }),
        }
        replacedUrl = imageDecided && current[i].imageUrl && current[i].imageUrl !== next[i].imageUrl ? current[i].imageUrl : null
        return next
      })
      if (isMutateReject(out)) throw refuse(404, out.reject)
      mirrored = await bestEffortMirror(tx, c, 'wine-list', () => mirrorLineup(tx, ctx.row?.id ?? null, out))
      return out.find(w => w.id === wineId)!
    })
  } catch (err) {
    if (uploaded) await reclaimIfUnreferenced(c, uploaded)
    return contractFailure(err, c, { label: 'wine-edit' })
  }
  // Only once the RECORD no longer references it (the mirror landed — r4 P1-1);
  // a failed mirror leaves the old bytes (a leak, never a dead reference).
  if (replacedUrl && mirrored) reclaimImages([replacedUrl])
  await touchWithMeta(c)

  // Same wire shape as GET so a client storing this response back into
  // its wines cache doesn't see a different shape than the polling GET
  // would produce — including the kicked-user fallback for the adder
  // name, so an edit response and the next poll resolve to the same
  // `addedByDisplayName` value.
  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([written], identities)
  return NextResponse.json(wineToWire(written, identity.id, identities, userNameLookup, meta.showProvenance !== false))
}

// Reassign "Brought by" (bounded v1), RECORD-FIRST inside the session mutation
// contract (plan D2): every check is re-made under the locks (the caller's
// fresh grant; the target admitted in this moment — by the record for a `u:`
// target); the lineup + the FORCED provenance commit in Postgres; the Redis
// provenance is the projection after COMMIT. Ownership decides provider edit
// rights, so the cache must never name an owner the record does not (A's
// Redis-first compensation could, after a crash). v1 is limited to
// Postgres-backed moments (docs/dev/proposals/reassign-brought-by.md).
async function reassignBroughtBy({
  c, wineId, body, identity, isHost, showProvenance,
}: {
  c: string
  wineId: string
  body: Record<string, unknown>
  identity: AuthorizedIdentity
  isHost: boolean
  showProvenance: boolean
}): Promise<NextResponse> {
  if (Object.keys(body).some(key => key !== 'broughtByIdentityId')) {
    return NextResponse.json({ error: 'change who brought it on its own — save other edits separately' }, { status: 400 })
  }
  if (!isHost) {
    return NextResponse.json({ error: 'only a host or co-host can change who brought an impression' }, { status: 403 })
  }
  if (!showProvenance) {
    return NextResponse.json({ error: 'turn on “show who brought each impression” to change it' }, { status: 400 })
  }
  // A tombstone (d:) is never a valid new owner.
  if (!isValidIdentityId(body.broughtByIdentityId) || isTombstoneIdentityId(body.broughtByIdentityId)) {
    return NextResponse.json({ error: 'invalid identity' }, { status: 400 })
  }
  const target = body.broughtByIdentityId as string
  try {
    const reassigned = await withSessionMutation(c, { label: 'reassign', redisLock: { waitMs: 3000 }, caller: identity }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!isHostByIdentity(ctx.meta!, caller)) throw refuse(403, 'only a host or co-host can change who brought an impression')
      const provenanceShown = ctx.row ? ctx.row.showProvenance !== false : ctx.meta!.showProvenance !== false
      if (!provenanceShown) throw refuse(400, 'turn on “show who brought each impression” to change it')
      // The new owner must be a current participant: live roster entry (its name
      // is the snapshot), not banned or kicked — and admitted by the record for
      // a `u:` target.
      const [targetName, inBans, inKicked] = await Promise.all([
        redis.hGet(k.identities(c), target), redis.sIsMember(k.bans(c), target), redis.sIsMember(k.kicked(c), target),
      ])
      const recordAdmits = /^u:\d{1,18}$/.test(target) && ctx.row
        ? await readGrant(tx, c, Number(target.slice(2))).then(g => !!g && grantStatus(g) === 'ok')
        : true
      if (!targetName || inBans || inKicked || !recordAdmits) throw refuse(400, 'that person is not in this moment')
      if (!ctx.row) {
        throw refuse(409, 'this moment isn’t saved yet — a signed-in guest needs to rate or join before you can change who brought it')
      }
      const raw = await redis.get(k.wines(c))
      if (raw === null) throw new ContractCold(c)
      const wines = JSON.parse(raw) as WineMeta[]
      const i = wines.findIndex(w => w.id === wineId)
      if (i === -1) throw refuse(404, 'wine not found')
      const next = wines.slice()
      next[i] = { ...wines[i], addedByIdentityId: target, addedByDisplayName: targetName }
      await reassignProvenance(tx, ctx.row.id, next, next[i])
      return next[i]
    }, async (ctx, wine) => {
      await mutateWines(ctx.fence!, (current) => {
        const i = current.findIndex(w => w.id === wineId)
        if (i === -1) return { reject: 'gone' }
        const next = current.slice()
        next[i] = { ...current[i], addedByIdentityId: wine.addedByIdentityId, addedByDisplayName: wine.addedByDisplayName }
        return next
      })
    })
    await touchWithMeta(c)
    const identities = await redis.hGetAll(k.identities(c))
    const userNameLookup = await buildKickedUserNameLookup([reassigned], identities)
    // Reaching here means showProvenance is on (gated above).
    return NextResponse.json(wineToWire(reassigned, identity.id, identities, userNameLookup, true))
  } catch (err) {
    return contractFailure(err, c, { busy: 429, label: 'reassign' })
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const { meta, wines } = opened
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  const targetWine = wines.find(w => w.id === wineId)
  if (!targetWine) return NextResponse.json({ error: 'wine not found' }, { status: 404 })
  // Same provider/host rules as PATCH. Early reject only — re-decided under the locks.
  if (!isHostByIdentity(meta, identity) && !(isProvider(meta, identity) && (!!identity.grant || targetWine.addedByIdentityId === identity.id))) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can delete it' }, { status: 403 })
  }

  // Inside the session mutation contract (the power and the record ownership
  // fresh under the locks): the fenced lineup filter (content), the mirror that
  // deletes the wine's row (its ratings cascade) and re-positions the rest, and
  // the wine's rating keys — every rating-key-deleting path holds the lease
  // (plan § 3, r3-3). The S3 bytes go after COMMIT.
  let deletedUrl: string | null = null
  let deleteMirrored = false
  try {
    await withSessionMutation(c, { label: 'wine-delete', redisLock: { waitMs: 3000 }, caller: identity, bumpGen: true }, async (tx, ctx) => {
      deletedUrl = null; deleteMirrored = false   // per attempt (r3 P1)
      const caller = admitted(ctx)
      const wine = await currentWine(c, wineId)
      if (!wine) throw refuse(404, 'wine not found')
      if (!isHostByIdentity(ctx.meta!, caller) && !(isProvider(ctx.meta!, caller) && await ownsWine(tx, ctx, caller, wine))) {
        throw refuse(403, 'only the host or the provider who added this wine can delete it')
      }
      const out = await mutateWines(ctx.fence!, (current) => {
        const gone = current.find(w => w.id === wineId)
        if (!gone) return { reject: 'wine not found' }
        deletedUrl = gone.imageUrl || null
        return current.filter(w => w.id !== wineId)
      })
      if (isMutateReject(out)) throw refuse(404, out.reject)
      deleteMirrored = await bestEffortMirror(tx, c, 'wine-list', () => mirrorLineup(tx, ctx.row?.id ?? null, out, { deletedId: wineId }))
      const ratingKeys = await scanKeys(`s:${c}:r:*:${wineId}`)
      if (ratingKeys.length > 0) await ctx.fence!.exec(m => { m.del(ratingKeys) })
    })
  } catch (err) {
    return contractFailure(err, c, { busy: 429, label: 'wine-delete' })
  }
  // The wine's S3 image after COMMIT: the URL it referenced (unique-keyed since
  // r3) and the legacy id-keyed object. Fire-and-forget.
  // Only when the record's wine row went too (r4 P1-1).
  if (deleteMirrored) {
    if (deletedUrl) reclaimImages([deletedUrl])
    deleteImage(wineId).catch(() => {})
  }
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
