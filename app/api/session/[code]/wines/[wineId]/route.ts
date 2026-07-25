import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, scanKeys } from '@/lib/redis'
import { isHostByIdentity, isProviderById, getSessionMeta, getWines, mutateWines, isMutateReject, addWineToSession, pgUpsertWine, pgReassignWineProvenance, pgSessionExists, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, isValidIdentityId } from '@/lib/identity'
import { deleteImage } from '@/lib/s3'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { acquireBanLock, releaseBanLock } from '@/lib/sessionBan'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { resolveCatalogLink, applyIdentityEditRule, catalogLinkRateKey, CatalogValidationError } from '@/lib/catalogWrite'
import type { Identity } from '@/lib/identity'
import type { SessionMeta, WineMeta } from '@/lib/session'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Hosts (including cohosts) can edit any wine. Providers can edit
  // only the wines they themselves added — matched via the wine's
  // `addedByIdentityId`. Wines from before the provider feature have
  // NULL provenance and aren't editable by providers.
  const isHost = isHostByIdentity(meta, identity)
  const isOwnAsProvider = isProviderById(meta, identity.id) && wines[idx].addedByIdentityId === identity.id
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can edit it' }, { status: 403 })
  }

  // ── Reassign "Brought by" — bounded v1 (docs/dev/proposals/reassign-brought-by.md,
  // shipped as the deliberately-scoped version, NOT the outbox design). It is an
  // OWNERSHIP-ONLY request: a PATCH carrying broughtByIdentityId may carry NOTHING
  // else (no name/producer/type/image/…), so the critical section is S3-free and
  // touches only the two provenance fields. Handled as its own branch — it never
  // goes through addWineToSession. Consistency is within the repo's existing
  // best-effort Redis→PG contract: synchronous PG mirror with Redis-restore
  // compensation on failure; a process crash / lock expiry / double failure can
  // still leave archival drift (documented, self-corrects on the next reassign),
  // same class as every other pgUpsertWine. Redis stays the live-auth source.
  if (body.broughtByIdentityId !== undefined) {
    return reassignBroughtBy({ c, wineId, body, meta, identity, isHost })
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

  const out = await mutateWines(c, (current) => {
    const i = current.findIndex(w => w.id === wineId)
    if (i === -1) return { reject: 'wine not found' }
    const next = current.slice()
    // Preserve the CURRENT provenance read inside the transform (D4). `result`
    // was built from a pre-transform snapshot; if a reassign committed between
    // that read and this write, splicing `result` wholesale would silently
    // revert the reassignment. Ordinary edits never change ownership, so always
    // carry the live owner from `current[i]` (WATCH re-runs this on conflict, so
    // it always reflects the latest committed provenance).
    next[i] = {
      ...result,
      addedByIdentityId: current[i].addedByIdentityId,
      addedByDisplayName: current[i].addedByDisplayName,
      // 🔒 SAME RULE FOR THE CATALOG LINK, for the same reason. `link` was
      // computed from a PRE-TRANSFORM snapshot, so on a COSMETIC edit (where
      // the rule resolved to "keep what's stored") splicing it wholesale would
      // write back the link as it looked BEFORE a concurrent re-link — silently
      // reverting that re-link, exactly as the provenance case above did.
      //
      // Only a DELIBERATE link decision may overwrite the live value: an
      // explicit re-link/clear from this request, or the identity-changing-edit
      // rule firing. `linkIsDeliberate` captures that distinction outside the
      // transform (it depends only on the request, not on current state), so
      // the transform stays pure and re-runs correctly under WATCH retry.
      ...(linkIsDeliberate
        ? { productId: link.productId, vintageId: link.vintageId }
        : { productId: current[i].productId ?? null, vintageId: current[i].vintageId ?? null }),
    }
    return next
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
  await touchWithMeta(c)
  // Build the response + PG mirror from the ACTUALLY-WRITTEN wine (`out[i]`), not
  // the pre-mutation `result`. They differ in exactly one case: a reassign
  // committed between our read and this write, so `written` carries the current
  // owner while `result` has the stale one. Using `written` keeps the response's
  // addedBy*/isMine truthful (Codex P3). PG mirror freezes provenance on update
  // regardless, so it never moves ownership from here.
  const written = (out as WineMeta[]).find(w => w.id === wineId)!

  if (session?.user) {
    // Best-effort mirror, provenance FROZEN on update (ordinary edits never move
    // ownership — only the reassign path forces it).
    try { await pgUpsertWine(c, written) } catch {}
  }

  // Same wire shape as GET so a client storing this response back into
  // its wines cache doesn't see a different shape than the polling GET
  // would produce — including the kicked-user fallback for the adder
  // name, so an edit response and the next poll resolve to the same
  // `addedByDisplayName` value.
  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([written], identities)
  return NextResponse.json(wineToWire(written, identity.id, identities, userNameLookup, meta.showProvenance !== false))
}

// Reassign "Brought by" (bounded v1). Ownership-only; runs the whole
// ownership-critical section under the ban lock (serialized with sessionWipe +
// the role endpoint + wine DELETE), re-authorizing against FRESH meta and
// re-validating the target inside the lock. Redis is written first, then PG is
// mirrored synchronously; on a PG failure the prior provenance is RESTORED in
// Redis (compensation) and the request 500s — no outbox. Accepted residual: a
// crash between the failed PG write and the compensating Redis restore leaves
// archival drift, self-correcting on the next reassign — same best-effort class
// as every pgUpsertWine. See docs/dev/proposals/reassign-brought-by.md.
async function reassignBroughtBy({
  c, wineId, body, meta, identity, isHost,
}: {
  c: string
  wineId: string
  body: Record<string, unknown>
  meta: SessionMeta
  identity: Identity
  isHost: boolean
}): Promise<NextResponse> {
  // Ownership-only: the body may contain ONLY broughtByIdentityId. A strict
  // allowlist (not a denylist of known fields) so an UNKNOWN key can't sneak
  // through — the contract is "may carry nothing else", and this stays correct
  // when new wine fields are added later (Codex P3).
  if (Object.keys(body).some(key => key !== 'broughtByIdentityId')) {
    return NextResponse.json({ error: 'change who brought it on its own — save other edits separately' }, { status: 400 })
  }
  // Cheap pre-lock rejections (re-checked against fresh meta inside the lock).
  if (!isHost) {
    return NextResponse.json({ error: 'only a host or co-host can change who brought an impression' }, { status: 403 })
  }
  if (meta.showProvenance === false) {
    return NextResponse.json({ error: 'turn on “show who brought each impression” to change it' }, { status: 400 })
  }
  if (!isValidIdentityId(body.broughtByIdentityId)) {
    return NextResponse.json({ error: 'invalid identity' }, { status: 400 })
  }
  const target = body.broughtByIdentityId as string

  // Ownership state is shared with sessionWipe (deletes wines by
  // addedByIdentityId) + role writes + wine DELETE — serialize under the ban lock.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json(
      { error: 'busy, try again' },
      { status: 429, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '1' } },
    )
  }
  try {
    // Re-authorize against FRESH meta (a demotion/ban that completed before the
    // lock is now visible).
    const freshMeta = await getSessionMeta(c)
    if (!freshMeta) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (!isHostByIdentity(freshMeta, identity)) {
      return NextResponse.json({ error: 'only a host or co-host can change who brought an impression' }, { status: 403 })
    }
    if (freshMeta.showProvenance === false) {
      return NextResponse.json({ error: 'turn on “show who brought each impression” to change it' }, { status: 400 })
    }
    // Target must be a current participant, NOT banned/kicked. Under the lock a
    // wipe can't run concurrently, so this is stable through the write.
    const [targetName, inBans, inKicked] = await Promise.all([
      redis.hGet(k.identities(c), target),
      redis.sIsMember(k.bans(c), target),
      redis.sIsMember(k.kicked(c), target),
    ])
    if (!targetName || inBans || inKicked) {
      return NextResponse.json({ error: 'that person is not in this moment' }, { status: 400 })
    }

    // v1 is limited to ALREADY-ARCHIVED sessions (Simon, 2026-07-20). Reject
    // BEFORE mutating Redis if there's no live PG session row — a pure Redis-only
    // anon moment (root CLAUDE.md: anon sessions stay Redis-only). We do NOT
    // force-archive it (that would break the anon lifecycle) and do NOT allow a
    // Redis-only ownership change (that would reintroduce the first-archival
    // provenance race when a logged-in participant later archives). This gate is
    // a fast pre-check, NOT a guarantee: session delete / account cleanup don't
    // take the ban lock, so the row can still vanish TOCTOU between here and the
    // mirror — handled at the mirror stage (pgReassignWineProvenance throws →
    // Redis compensation → 500). Documented bounded-v1 limitation: attribution
    // can't be changed on a moment that no logged-in participant has archived yet.
    if (!(await pgSessionExists(c))) {
      return NextResponse.json(
        { error: 'this moment isn’t saved yet — a signed-in guest needs to rate or join before you can change who brought it' },
        { status: 409 },
      )
    }

    // Capture the PRIOR provenance for compensation, then write the two fields.
    // mutateWines rejects if the wine was concurrently deleted (→ 404), so no
    // resurrection of a gone wine.
    let prior: { id?: string; name?: string } | null = null
    const out = await mutateWines(c, (current) => {
      const i = current.findIndex(w => w.id === wineId)
      if (i === -1) return { reject: 'wine not found' }
      prior = { id: current[i].addedByIdentityId, name: current[i].addedByDisplayName }
      const next = current.slice()
      next[i] = { ...current[i], addedByIdentityId: target, addedByDisplayName: targetName }
      return next
    })
    if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
    await touchWithMeta(c)
    const reassigned = (out as WineMeta[]).find(w => w.id === wineId)!

    // Synchronous PG mirror — UPSERTS the wine row with the new owner FORCED on
    // both create + update (a provenance-only update could no-op if the wine row
    // is absent while the session row exists — e.g. session archived but this
    // wine not yet — letting a later archival write create it with the OLD
    // owner). The 409 gate above ensured a session row existed, but session
    // delete / account cleanup DON'T take the ban lock, so it can vanish TOCTOU —
    // pgReassignWineProvenance THROWS in that case (not a silent no-op), landing
    // in the catch below. On any failure, COMPENSATE: restore prior Redis
    // provenance and 500. No outbox; the client retries the idempotent request once.
    try {
      await pgReassignWineProvenance(c, reassigned)
    } catch {
      try {
        await mutateWines(c, (current) => {
          const i = current.findIndex(w => w.id === wineId)
          if (i === -1) return { reject: 'gone' } // wine deleted meanwhile — nothing to restore
          const next = current.slice()
          next[i] = { ...current[i], addedByIdentityId: prior?.id, addedByDisplayName: prior?.name }
          return next
        })
      } catch {
        // Double failure (compensation also failed) — documented accepted
        // residual: Redis holds the new owner, PG holds the old. Self-corrects
        // on the next reassign of this wine. Redis is still the live-auth truth.
      }
      return NextResponse.json({ error: 'could not save; please try again' }, { status: 500 })
    }

    const identities = await redis.hGetAll(k.identities(c))
    const userNameLookup = await buildKickedUserNameLookup([reassigned], identities)
    // showProvenance is guaranteed not-false here (rejected above), so the echo
    // always surfaces the new owner.
    return NextResponse.json(wineToWire(reassigned, identity.id, identities, userNameLookup, true))
  } finally {
    await releaseBanLock(c)
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  const wines = await getWines(c)
  const targetWine = wines.find(w => w.id === wineId)
  if (!targetWine) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Same provider/host rules as PATCH.
  const isHost = isHostByIdentity(meta, identity)
  const isOwnAsProvider = isProviderById(meta, identity.id) && targetWine.addedByIdentityId === identity.id
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can delete it' }, { status: 403 })
  }

  // Take the ban lock so a delete and a "Brought by" reassign of the SAME wine
  // serialize (D4, DELETE arm) — otherwise a reassign could mirror provenance to
  // PG for a wine this delete is removing, leaving a PG-only orphan. Same lock
  // the reassign path + role endpoint + sessionWipe hold. Ordinary field edits
  // don't touch ownership state and stay lock-free.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json(
      { error: 'busy, try again' },
      { status: 429, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '1' } },
    )
  }
  try {
    // Re-authorize inside the lock against FRESH meta + FRESH wine ownership —
    // the pre-lock check (above) can go stale: a provider passes as owner A,
    // then a reassign moves the wine A→B (or a cohost is demoted) before the
    // lock is acquired. Without this a no-longer-owner provider could still
    // delete. (Codex P2.) Host/cohost re-check + provider own-wine re-check on
    // the CURRENT addedByIdentityId.
    const freshMeta = await getSessionMeta(c)
    if (!freshMeta) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const freshWine = (await getWines(c)).find(w => w.id === wineId)
    if (!freshWine) return NextResponse.json({ error: 'wine not found' }, { status: 404 })
    const freshIsHost = isHostByIdentity(freshMeta, identity)
    const freshOwnAsProvider = isProviderById(freshMeta, identity.id) && freshWine.addedByIdentityId === identity.id
    if (!freshIsHost && !freshOwnAsProvider) {
      return NextResponse.json({ error: 'only the host or the provider who added this wine can delete it' }, { status: 403 })
    }

    const out = await mutateWines(c, (current) => {
      if (!current.some(w => w.id === wineId)) return { reject: 'wine not found' }
      return current.filter(w => w.id !== wineId)
    })
    if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
    const ratingKeys = await scanKeys(`s:${c}:r:*:${wineId}`)
    if (ratingKeys.length > 0) await redis.del(ratingKeys)
    deleteImage(wineId).catch(() => {})
    await touchWithMeta(c)

    try { await prisma.wine.delete({ where: { id: wineId } }) } catch {}

    return NextResponse.json({ ok: true })
  } finally {
    await releaseBanLock(c)
  }
}
