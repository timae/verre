import { WatchError } from 'redis'
import { redis, k, lifespanTTL, scanKeys } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { sessionLockKey, LockLost } from '@/lib/sessionLock'
import { withSessionMutation, scopedInvalidate, ContractCold, ContractGone, type Fence } from '@/lib/sessionMutation'
import { prepareCachedLineup, copyCachedLineup, renumber, recordLineup, projectLineup } from '@/lib/occurrences'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'
import { kindOfStyle } from '@verre/core'
import { entryKey, type CatalogEntry } from '@/lib/catalogEntries'
import { snapshotFor, type BottleSnapshot } from '@/lib/occurrences'
import { cleanCountry, cleanUrl, scrub } from '@/lib/textSafe'
import { grantStatus, type AuthorizedIdentity } from '@/lib/sessionGrant'
import { userIdentityId } from '@/lib/identity'
import { seedParticipation } from '@/lib/momentDefaults'

export type WineMeta = {
  id: string
  name: string
  producer: string
  vintage: string
  grape: string
  type: string
  image: string
  imageUrl: string
  description?: string
  region?: string
  country?: string
  vinification?: string
  purchaseUrl?: string
  revealedAt?: string | null
  // Identity-id of the participant who added this wine. Used by two
  // independent flows: (1) kick/ban to identify which wines a host can
  // choose to orphan; (2) the provider role, which can edit/delete only
  // wines they added (matched via this field). Optional for backward
  // compat with pre-feature wine rows — those NULL rows never match a
  // ban-target filter and a provider's own-wine check rejects them
  // because `undefined !== provider.id`. The provenance anchor is
  // independent of the role grant: a former provider who got demoted
  // still has `addedByIdentityId` on their wines, but loses edit power
  // until re-promoted.
  //
  // Server-only — the wines GET wire payload strips this field and
  // replaces it with a per-caller `isMine` boolean so anon-id
  // correlation across multiple wines stays server-internal.
  addedByIdentityId?: string
  // Snapshot of the adder's display name at create time, used as a
  // fallback when the live identities map no longer has them (kicked
  // anon adder is the canonical case). Frozen forever — edits never
  // refresh it. The wire resolution at read time prefers the live map
  // first, falls back to users.name for logged-in adders, then to this
  // snapshot. Unlike addedByIdentityId, this is safe to surface on the
  // wire — display names are already public via the identities map.
  addedByDisplayName?: string
  // ── Wine-catalog link (phase 2) ──────────────────────────────────────
  //
  // Optional link from this per-session wine INSTANCE to the shared
  // catalog, at two grains because year = null means the NV row
  // exclusively. Valid states: (set, set) | (set, null) | (absent,
  // absent) — vintageId without productId is invalid and is rejected at
  // every write boundary AND by a DB CHECK on the mirrored columns.
  //
  // Set from an EXPLICIT user choice or a freshly-minted provisional,
  // never from a string match (RFC § v1 data model; the sole exception is
  // the phase-5 legacy backfill, which is exact-match-only).
  //
  // 🔒 BLIND REDACTION MUST STRIP BOTH. A catalog id in a blind payload is
  // a lookup oracle for the label — it identifies the wine as precisely as
  // the name does. `redactWine` builds a blind row as an ALLOW-LIST (since
  // the catalogue model change step 4), so a field added here stays OFF a
  // blind row until it is listed there. See lib/wineRedaction.ts.
  //
  // Stored on the occurrence row (record-first, lib/occurrences.ts); every
  // edit path must round-trip them (normalizeWine keeps an omitted link).
  productId?: string | null
  vintageId?: string | null
}

// Wire shape produced by `wineToWire` — same as `WineMeta` minus
// the server-only `addedByIdentityId` field, plus two wire-only flags:
// `isMine: boolean` (synthesized per-caller at response time) and
// `_blind?: boolean` (set by the blind-redaction path in the wines GET
// when a wine is hidden from the caller). The `addedByDisplayName`
// field is widened from optional-string-snapshot on `WineMeta` to
// resolved-string-or-null on the wire (live map → users.name →
// snapshot → null). Neither isMine nor _blind lives on `WineMeta`:
// they're never stored in Redis or Postgres, only emitted on the
// wire, so keeping them off the storage type prevents accidental
// reads that would always be undefined.
// 🔒 The catalogue model change (step 4): the line-up item is the OCCURRENCE's
// fields plus ONE `entry` key carrying the catalogue identity (merges
// followed, lib/catalogEntries.ts), which a blind row replaces wholesale
// (lib/wineRedaction.ts). No legacy `type` and no flat `productId` /
// `vintageId` on the wire (the version floor blocks every build that read
// them, spec § 7): `colour` / `sparkling` are the bottle's kind (its snapshot,
// the axes' input; they stay on a blind row), `abv` the alcohol (the entry's,
// a legacy alcohol-free bottle 0; null on a blind row, ruled 2026-11-20).
// `grape` / `region` / `country` / `description` / `vinification` /
// `purchaseUrl` are the bottle's own stored values (history, and its notes).
export type WireWine = Omit<WineMeta, 'addedByIdentityId' | 'addedByDisplayName' | 'type' | 'productId' | 'vintageId'> & {
  colour: string | null
  sparkling: boolean
  abv: number | null
  entry: CatalogEntry | null
  isMine: boolean
  addedByDisplayName: string | null
  // PUBLIC user id (lib/publicIds.ts) of a logged-in adder ONLY (null for
  // anon adders, pre-feature wines and an adder whose users row is gone).
  // Lets the brought-by surface render as a clickable profile link without
  // re-exposing the raw addedByIdentityId. 🔒 Never the integer.
  addedByUserId: string | null
  _blind?: boolean
  // The signed-in viewer's save state (lib/cravings.ts savedFlags, catalogue
  // model change § 5): on a row hidden for them ("Wine N") only their save of
  // THAT bottle, never whether they crave the wine; absent for a guest.
  saved?: boolean
}

// The SINGLE sanctioned wire transform — every endpoint that returns
// wines must route through here. Skipping it leaks `addedByIdentityId`,
// which would let a viewer correlate which wines came from the same anon
// adder across a session.
//
// Resolution priority for `addedByDisplayName`:
//   1. identities[addedByIdentityId]      (live participant name)
//   2. userNameLookup[addedByIdentityId]  (kicked logged-in adder)
//   3. snapshot on the wine                (kicked anon adder; pre-feature has no snapshot)
//   4. null
//
// `addedByUserId` exposes ONLY logged-in adders' PUBLIC id (from the adder
// lookup, which carries it in the same users read) so the UI can render the
// brought-by name as a clickable profile link. Anonymous adders' `a:<uuid>`
// is never surfaced (prevents anon-id correlation across wines from the same
// adder, same rationale as the `addedByIdentityId` strip). A `u:` adder
// missing from the lookup gets null (🔒 the integer never leaves).
// `showProvenance` (default true) is the "Show who brought each impression"
// session setting. When false the host opted OUT of attribution, so the
// resolved name + userId are forced to null HERE — at the single sanctioned
// wire transform — so EVERY caller (buildWinesView reads AND the four wine
// mutation routes that echo a wire wine back) inherits the strip structurally,
// exactly like redactWine nulls identity in-place. `isMine` is NOT affected:
// it's the caller's own trust flag, never rendered as attribution. Doing this
// here (not post-hoc in one reader) was a review fix — a strip that lived only
// in buildWinesView leaked provenance through the add/edit/reorder/reveal
// responses to the host/cohost/provider caller.
// `entries`: the catalogue entries of these bottles (lib/catalogEntries.ts
// loadEntries, keyed by the STORED link); a link the catalogue no longer has
// (purged) reads as no entry, the snapshot stands. `snapshots`: the record's
// colour / sparkling / abv of these bottles (lib/occurrences.ts readSnapshots;
// none for a Redis-only moment, whose cached token decides).
export function wineToWire(
  w: WineMeta,
  callerId: string,
  identities: Record<string, string> = {},
  lookup: AdderLookup = emptyAdderLookup(),
  showProvenance = true,
  entries: Map<string, CatalogEntry> = new Map(),
  snapshots: Map<string, BottleSnapshot> = new Map(),
): WireWine {
  const { addedByIdentityId: provenance, addedByDisplayName: snapshot, type, productId, vintageId, ...rest } = w
  const userNameLookup = lookup.names
  let resolvedName: string | null = null
  let userId: string | null = null
  const lookedUp = provenance ? userNameLookup.get(provenance) : undefined
  if (provenance && showProvenance && lookedUp === UNRESOLVED_USER) {
    // The users lookup failed: whether this adder still exists is unknown, so
    // the name is withheld rather than taken from a possibly stale cache.
  } else if (provenance && showProvenance && lookedUp === GONE_USER) {
    // 🔒 A `u:` adder whose users row is gone is never legitimate after account
    // deletion (redis-rehydration § 4.3): the d: migration of the live copy is
    // a post-commit projection that can fail or never run, and then the stale
    // identities entry or the snapshot would render the deleted person's name.
    resolvedName = '[deleted]'
  } else if (provenance && showProvenance) {
    if (identities[provenance]) resolvedName = identities[provenance]
    else if (provenance.startsWith('u:') && userNameLookup.has(provenance)) {
      resolvedName = userNameLookup.get(provenance)!
    }
    else if (snapshot) resolvedName = snapshot
    if (provenance.startsWith('u:')) {
      const n = Number(provenance.slice(2))
      if (Number.isInteger(n) && n > 0) userId = lookup.publicIds.get(n) ?? null
    }
  }
  const entry = productId ? entries.get(entryKey(productId, vintageId)) ?? null : null
  const snap = snapshotFor(w, snapshots)
  const kind = snap ?? kindOfStyle(type)
  return {
    ...rest,
    colour: kind.colour,
    sparkling: kind.sparkling,
    // The bottle's own abv (its snapshot, what the badges count: Codex r2),
    // else the entry's (a Redis-only moment), else a legacy alcohol-free 0.
    abv: snap ? snap.abv : entry ? entry.abv : type === 'nonalc' ? 0 : null,
    entry,
    // isMine keys on the raw provenance, independent of showProvenance — the
    // caller's own edit affordance must survive attribution being hidden.
    isMine: !!provenance && provenance === callerId,
    addedByDisplayName: resolvedName,
    addedByUserId: userId,
  }
}

export type RatingMeta = {
  score: number
  flavors: Record<string, number>
  // Aroma selections ({a: nodeId, m: modifierId|null, p?: true} against the
  // @verre/core taxonomy; the node may sit at any tier — leaf/subfamily/
  // family; `p` = pronounced, present only when true). Optional: ratings
  // written before the aromas field lack the key.
  aromas?: { a: string; m: string | null; p?: boolean }[]
  notes: string
  at: number
  // The rating's version (`rating_versions.version`, docs/dev/rating-saves.md):
  // on a signed-in rating of a Postgres-backed moment, written with every key
  // since the rating-saves release; absent = 0 (never rated, a pre-release
  // rating with no write since, a guest). 🔒 On the wire ONLY on the caller's
  // own rows (buildRatingsView strips it from everyone else's).
  v?: number
}

export type SessionMeta = {
  host: string
  name: string
  createdAt: number
  hostUserId: number | null
  // Identity id of the host. `u:<userId>` for logged-in hosts (redundant with
  // hostUserId), `a:<uuid>` for anonymous hosts (the only stable handle).
  hostIdentityId?: string
  blind?: boolean
  // "Blind for all" — stacks on top of meta.blind. When true, the host,
  // cohosts, providers, and wine-adders ALL see redacted wines (same as
  // tasters). Lets a host run a tasting where nobody — including
  // themselves — knows the lineup. Toggleable mid-session by any
  // host/cohost; the toggle is per-session (not per-cohost). Composes
  // with reveal: revealed wines un-redact for everyone regardless.
  // No-op when meta.blind is false.
  blindForEveryone?: boolean
  lifespan?: string
  coHostIds?: string[]
  // Provider role: can add wines and edit/delete the wines they added,
  // but has no other host powers (no settings, no reorder, no reveal,
  // no moderation). Mutually exclusive with cohost. Trust anchor lives
  // here in Redis; mirrored to session_members.role on Postgres.
  providerIds?: string[]
  address?: string
  dateFrom?: string | null
  dateTo?: string | null
  timezone?: string
  description?: string
  link?: string
  hideLineup?: boolean
  hideLineupMinutesBefore?: number
  // Whether the "Brought by" attribution (who added each impression) is shown
  // to viewers. DEFAULT ON: absent or true → shown; false → the host opted out
  // and the read path (buildWinesView) nulls addedByDisplayName +
  // addedByUserId off the wire so NO surface — impression detail, web callout,
  // feed cards — can render it. PRO-gated at the settings write, but reading it
  // never gates on pro (a moment set private stays private for everyone).
  // Independent of blind: blind hides the impression's IDENTITY, this hides its
  // PROVENANCE. On existing moments the field is absent → attribution unchanged.
  showProvenance?: boolean
  // Host-chosen cover photo (S3 URL). Deliberately NOT blind-redacted — it
  // brands the moment, not a wine. S3 bytes reclaimed in every deletion path.
  coverPhotoUrl?: string
  // Session category ('wine' for now) — the future contract for what
  // impressions can be added + the category vocabulary. Mirrors
  // sessions.category.
  category?: string
  // Promotion time (sessions.archived_at), epoch ms: stamped by promotion's
  // fenced projection and by every meta written from the record. Presentation
  // only — nothing gates on it.
  promotedAt?: number
}

// Where each SessionMeta field is durable (redis-rehydration § 4.2 / § 5.2).
// `Record<keyof SessionMeta, …>` is exhaustive: a field added to SessionMeta
// fails `tsc` here until someone decides where it lives — a field nobody
// classified is a field that silently disappears on the first Redis wipe.
//   'column'          — a sessions column, written by sessionMetaToColumns
//   'session_members' — derived from session_members.role (the role mirror)
//   'derived'         — reconstructible from other columns (u:<host_user_id>)
export const SESSION_META_PERSISTENCE: Record<keyof SessionMeta, 'column' | 'session_members' | 'derived'> = {
  host: 'column', name: 'column', createdAt: 'column', hostUserId: 'column',
  hostIdentityId: 'derived', blind: 'column', blindForEveryone: 'column',
  lifespan: 'column', coHostIds: 'session_members', providerIds: 'session_members',
  address: 'column', dateFrom: 'column', dateTo: 'column', timezone: 'column',
  description: 'column', link: 'column', hideLineup: 'column',
  hideLineupMinutesBefore: 'column', showProvenance: 'column',
  coverPhotoUrl: 'column', category: 'column', promotedAt: 'column',
}

// 🔒 The ONE spelling of SessionMeta → sessions columns (R1-11). The logged-in
// create, the promotion create arm (pgUpsertSession) and the settings PATCH
// mirror all write this; they had drifted when each listed columns by hand.
// Absent optional settings map to NULL, which every reader treats as the
// default (48h, lineup shown, provenance shown). The settings mirror omits the
// identity + creation columns: sessionSettingsColumns is the mutable subset.
export function sessionMetaToColumns(meta: SessionMeta) {
  return {
    hostName: meta.host,
    hostUserId: meta.hostUserId,
    createdAt: new Date(meta.createdAt),
    ...sessionSettingsColumns(meta),
  }
}

// The columns a settings save may change. Never the host or creation columns:
// writing those from a request's meta could put back a host that account
// deletion tombstoned in Postgres after the request read Redis.
export function sessionSettingsColumns(meta: SessionMeta) {
  return {
    name: meta.name || null,
    blind: !!meta.blind,
    blindForEveryone: !!meta.blindForEveryone,
    address: meta.address || null,
    dateFrom: meta.dateFrom ? new Date(meta.dateFrom) : null,
    dateTo: meta.dateTo ? new Date(meta.dateTo) : null,
    timezone: meta.timezone || null,
    description: meta.description || null,
    link: meta.link || null,
    coverPhotoUrl: meta.coverPhotoUrl || null,
    category: meta.category || 'wine',
    lifespan: meta.lifespan ?? null,
    hideLineup: meta.hideLineup ?? null,
    hideLineupMinutesBefore: meta.hideLineupMinutesBefore ?? null,
    showProvenance: meta.showProvenance ?? null,
  }
}

export { genCode } from '@/lib/sessionCode'

// No raw meta/lineup getters: session routes open the session with
// openSession / loadLiveWines (lib/sessionRehydrate.ts — absent-aware, never a
// `[]` for an evicted lineup), and list/enrichment reads keep their own raw
// reads and never rebuild (redis-rehydration § 5.3).

// Sentinel a transform returns to abort the write based on the CURRENT
// wines state (e.g. the target wine was deleted by a concurrent request
// between read and write). Distinct from throwing — a reject is an
// expected outcome the caller maps to a 404/400, not an error.
export type MutateReject = { reject: string }
export function isMutateReject(v: unknown): v is MutateReject {
  return typeof v === 'object' && v !== null && 'reject' in v
}

// Atomic read-modify-write of the `s:{CODE}:wines` blob, FENCED by the session
// lock (redis-rehydration § 4.6 / mechanism 1+2): the caller holds
// lock:session:{CODE} inside a mutation contract and passes its fence. On an
// isolated connection: WATCH the lock + wines, check the token, read, transform,
// MULTI SET XX KEEPTTL, EXEC — a holder that lost its lease writes nothing
// (LockLost), and a concurrent change retries with the fresh value.
//
// 🔒 An absent wines key is a REJECT, never a create (ContractCold → the route
// answers through ensureSessionLive: a rebuild then 503, or 404 if the session is
// really gone). A wiped or evicted lineup can never be recreated holding only
// one wine by a writer working from stale state.
//
// The transform MUST be pure (it re-runs on each retry): side effects (S3,
// Postgres, response building) stay in the caller. Return a MutateReject for
// current-state validation (e.g. wine gone → the caller maps it to 404/400).
export async function mutateWines(
  fence: Fence,
  transform: (wines: WineMeta[]) => WineMeta[] | MutateReject,
): Promise<WineMeta[] | MutateReject> {
  const code = fence.code
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fence.client.executeIsolated(async (client) => {
        await client.watch([sessionLockKey(code), k.wines(code)])
        try {
          if ((await client.get(sessionLockKey(code))) !== fence.token) throw new LockLost(code)
          const raw = await client.get(k.wines(code))
          if (raw === null) throw new ContractCold(code)
          // A throwing transform (or malformed JSON) must release the WATCH —
          // the connection returns to the pool.
          const next = transform(JSON.parse(raw))
          if (isMutateReject(next)) {
            await client.unwatch()
            return next
          }
          const res = await client.multi().set(k.wines(code), JSON.stringify(next), { XX: true, KEEPTTL: true }).exec()
          if (res === null) throw new WatchError()
          return next
        } catch (inner) {
          await client.unwatch().catch(() => {})
          throw inner
        }
      })
    } catch (err) {
      if (err instanceof WatchError) continue
      throw err
    }
  }
  throw new Error(`mutateWines: too much contention on ${k.wines(code)}`)
}

// ── Privilege helpers (redis-rehydration § 4.7) ─────────────────────────────
//
// 🔒 They take an AuthorizedIdentity (lib/sessionGrant.ts), never a raw
// resolveIdentity() result: for a `u:` caller of a Postgres-backed session the
// answer comes from `identity.grant` — the COMMITTED record — and the cached
// role lists in meta are presentation only (a stale cohost/provider entry
// grants nothing), and a role grants nothing while its holder is kicked or banned
// (grantStatus must be 'ok' — r2 N1). Without a grant (anonymous caller, Redis-only session) Redis
// meta is the authority, as before. Inside a contract, pass ctx.caller (fresh
// grant), never the pre-lock identity.

// Strict host OR cohost — host-equivalent actions (wines, settings, reveals,
// kick/ban of tasters). Strict-host-only actions use isStrictHost.
export function isHostByIdentity(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && (identity.grant.strictHost || identity.grant.role === 'co_host')
  return isStrictHost(meta, identity) || !!meta.coHostIds?.includes(identity.id)
}

// The original session host only — cohost role assignment, session delete,
// banning a cohost.
export function isStrictHost(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && identity.grant.strictHost
  if (meta.hostIdentityId && identity.id === meta.hostIdentityId) return true
  if (meta.hostUserId && identity.id === userIdentityId(meta.hostUserId)) return true
  return false
}

// Provider: its own tier, NOT a superset of host — may add wines and edit/
// delete only the wines it added. Ownership itself (wines.added_by_identity_id)
// is checked by the caller, from the record for a `u:` caller with a grant
// (plan § 2, G2).
export function isProvider(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && identity.grant.role === 'provider'
  return !!meta.providerIds?.includes(identity.id)
}

// Session-wide "no host identity at all" (§ 4.5): ruling 4 lets cohosts delete a
// host-less moment. Never a display-name branch.
export function isHostless(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (identity?.grant) return identity.grant.hostless && !meta.hostIdentityId
  return !meta.hostIdentityId && !meta.hostUserId
}

// The largest occurrence photo the image call accepts, as a base64 data URL
// (the app's MAX_WINE_IMAGE_BYTES mirrors it).
export const MAX_WINE_IMAGE_DATA_URL = 1_500_000

// `scrub()` handles control chars + bidi/zero-width spoofing. It
// returns null for empty input; we coerce back to '' here so the
// existing wine-name truthy check still works the same way.
function clean(v: unknown): string {
  return scrub(v) ?? ''
}

// cleanUrl/cleanCountry moved to lib/textSafe.ts (pure, no Redis side effect
// — /api/checkins uses them without touching this module). Re-exported so
// existing `@/lib/session` importers (sessionFields, settings route) stay
// unchanged; normalizeWine below keeps using them.
export { cleanCountry, cleanUrl }

// Sentinel values in the name lookup: this `u:` adder's account is gone; or
// the lookup failed, so whether it is gone is unknown.
export const GONE_USER = '\u0000gone'
export const UNRESOLVED_USER = '\u0000unresolved'

// Batch-lookup the `u:<id>` adders of these wines: display names for those
// no longer in the session's identities map (kicked / banned logged-in
// users), GONE_USER for those whose users row no longer exists (deleted
// accounts — wineToWire then renders '[deleted]' whatever the identities map
// or snapshot still say), and every live adder's PUBLIC id (the wire's
// `addedByUserId`). One Prisma query per request; no `u:` adder
// short-circuits. Anonymous adders (`a:<uuid>`) have no users row and are
// excluded.
//
// Used by the wines GET / reorder / POST / PATCH / reveal routes when
// they build the wire response. A Postgres failure withholds every `u:`
// adder's name AND public id (fail closed) so the live wines polling endpoint
// keeps working through a DB hiccup.
export type AdderLookup = { names: Map<string, string>; publicIds: Map<number, string> }
export const emptyAdderLookup = (): AdderLookup => ({ names: new Map(), publicIds: new Map() })

export async function buildAdderLookup(
  wines: WineMeta[],
  identities: Record<string, string>,
): Promise<AdderLookup> {
  const userIds = new Set<number>()
  for (const w of wines) {
    const id = w.addedByIdentityId
    if (!id || !id.startsWith('u:')) continue
    const n = Number(id.slice(2))
    if (Number.isInteger(n) && n > 0) userIds.add(n)
  }
  const out = emptyAdderLookup()
  if (userIds.size === 0) return out
  try {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true, publicId: true },
    })
    const found = new Map(rows.map(r => [`u:${r.id}`, r.name]))
    for (const r of rows) out.publicIds.set(r.id, r.publicId)
    for (const n of userIds) {
      const id = `u:${n}`
      const name = found.get(id)
      if (name === undefined) out.names.set(id, GONE_USER)
      else if (!identities[id]) out.names.set(id, name)
    }
  } catch (err) {
    // Fail closed on names: a deleted adder's stale identities entry or
    // snapshot must not render because Postgres was briefly unreachable.
    console.error('[wines] buildAdderLookup failed — withholding u: adder names:', err)
    for (const n of userIds) out.names.set(`u:${n}`, UNRESOLVED_USER)
  }
  return out
}

// The bottle's OWN fields from a body (catalogue model change step 4; ruled
// 2026-11-20: "About" and vinification stay on the bottle, like the purchase
// link): only those present, cleaned as the columns take them. Its identity
// (name, producer, year, kind, grape, region, origin) is the entry's snapshot
// (lib/catalogLink.ts), never read from a body.
export function cleanBottleNotes(body: Record<string, unknown>): { description?: string; vinification?: string; purchaseUrl?: string } {
  const out: { description?: string; vinification?: string; purchaseUrl?: string } = {}
  if (body.description !== undefined) out.description = clean(body.description).slice(0, 1000)
  if (body.vinification !== undefined) out.vinification = clean(body.vinification).slice(0, 1000)
  if (body.purchaseUrl !== undefined) out.purchaseUrl = cleanUrl(body.purchaseUrl).slice(0, 1000)
  return out
}

// ── Postgres side of a session (redis-rehydration § 4.4 / § 4.6) ─────────────
//
// 🔒 Mode is decided by whether the live `sessions` row exists, never by the
// caller's login state — and that decision is made INSIDE the writer's mutation
// contract (ctx.row, read FOR UPDATE under the advisory lock), so it stays true
// until COMMIT. Both soft-delete paths take the same locks.

// Promotion (Redis-only → Postgres-backed), the create arm of the old
// pgUpsertSession, now ONE unit of work inside the contract (§ 4.4): under the
// Redis lock + advisory lock, with the incarnation checked against the caller's
// meta and the delete registry checked so a stale caller cannot promote what a
// committed delete removed; the snapshot (meta, lineup, bans, roster) is read
// INSIDE. Writes the row, the lineup (positions), the bans and a member row for
// EVERY registered `u:` (G3 — roles from the fresh meta, the one moment Redis is
// still the authority; kicked-set entries as removed_state 'kicked'; joined
// counters on insert). The row is 'unlimited' whatever the guest moment's
// lifespan was: once Postgres-backed it is reopenable forever, so the lifespan
// only sizes the cache (root CLAUDE.md § Freemium split). Projection: meta
// rewritten from the record (promotedAt, lifespan), then every key re-stamped to
// the new TTL, since the meta write is KEEPTTL and the guest TTL would otherwise
// survive. A projection failure leaves the record right and the request served,
// and invalidates the cache: the next open rebuilds it on 'unlimited'.
// The trigger stays "a logged-in caller acted" (the callers decide that), and it
// runs BEFORE the caller's own contract — the locks are not re-entrant.
// Returns the live sessions.id.
export async function ensurePromoted(code: string, meta: SessionMeta): Promise<number> {
  const live = await prisma.session.findFirst({ where: { code, deletedAt: null }, select: { id: true } })
  if (live) return live.id
  return withSessionMutation(code, { label: 'promote', redisLock: { waitMs: 8000 }, expectedCreatedAt: meta.createdAt },
    async (tx, ctx) => {
      if (ctx.row) return ctx.row.id
      const fresh = ctx.meta!
      const dead = await tx.$queryRaw<{ x: number }[]>`
        SELECT 1 AS x FROM session_tombstones WHERE code = ${code} AND created_at = ${new Date(fresh.createdAt)}`
      if (dead[0]) throw new ContractGone(code)
      const winesRaw = await redis.get(k.wines(code))
      if (winesRaw === null) throw new ContractCold(code)
      const [bans, identities, kicked] = await Promise.all([
        redis.sMembers(k.bans(code)), redis.hGetAll(k.identities(code)), redis.sMembers(k.kicked(code)),
      ])
      const row = await tx.session.create({ data: { code, ...sessionMetaToColumns(fresh), lifespan: 'unlimited' }, select: { id: true } })
      // Belt: member rows are only ever for codes with a live row (r1-2).
      await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${code}`
      // The cached line-up through the shared record insert (lib/occurrences.ts
      // copyLineup: ids, order, reveal state, the snapshot), stamped 1 in this
      // transaction (spec § 8a "Promotion stamps 1").
      // A cached id another row of the record holds (a squat) gets a fresh id,
      // its rating keys copied now and the old ones deleted after COMMIT
      // (review r1, r2): never a silent drop.
      const prep = await prepareCachedLineup(tx, row.id, winesRaw)
      if (prep) await copyCachedLineup(tx, ctx, row.id, prep)
      await renumber(tx, row.id)
      await tx.$executeRaw`UPDATE sessions SET lineup_revision = 1 WHERE id = ${row.id}`
      if (bans.length > 0) {
        await tx.$executeRaw`
          INSERT INTO session_bans (session_code, identity_id) SELECT ${code}, unnest(${bans}::text[]) ON CONFLICT DO NOTHING`
      }
      const userIds = (ids: string[]) => ids.filter(id => /^u:\d{1,18}$/.test(id) && !bans.includes(id)).map(id => Number(id.slice(2)))
      const candidates = [...new Set([...userIds(Object.keys(identities)), ...userIds(kicked)])]
      const users = candidates.length
        ? await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${candidates}::bigint[]) FOR KEY SHARE`
        : []
      const entered: number[] = []
      for (const { id } of users) {
        const uid = `u:${id}`
        const role = fresh.hostUserId === Number(id) || fresh.hostIdentityId === uid ? 'host'
          : fresh.coHostIds?.includes(uid) ? 'co_host'
          : fresh.providerIds?.includes(uid) ? 'provider'
          : 'taster'
        const removed = kicked.includes(uid) && !(uid in identities) ? 'kicked' : null
        const inserted = await tx.$queryRaw<{ user_id: number }[]>`
          INSERT INTO session_members (user_id, session_code, role, removed_state) VALUES (${Number(id)}, ${code}, ${role}, ${removed})
          ON CONFLICT (user_id, session_code) DO NOTHING RETURNING user_id`
        if (inserted[0]) await tx.$executeRaw`UPDATE users SET lifetime_sessions_joined = lifetime_sessions_joined + 1 WHERE id = ${Number(id)}`
        if (inserted[0] && !removed && Number(id) !== fresh.hostUserId) entered.push(Number(id))
      }
      // 🔒 An ENTRY writer (Moment Defaults K1): each NON-kicked inserted person
      // gets their OWN defaults (never the promoter's), in ONE statement. Rows
      // inserted kicked may be pre-emptive placeholders: they seed on
      // re-admission (`/join`). No host settings at promotion: a guest-hosted
      // moment stays closed by the trigger.
      await seedParticipation(tx, row, entered)
      return row.id
    },
    async (ctx) => {
      // ctx.row is null here (this work created the row), so the contract's own
      // failure path would not invalidate: a cache left on the guest lifespan
      // would keep renewing it (touchWithMeta reads meta.lifespan). Invalidate
      // the committed incarnation instead; the next open rebuilds every key from
      // the record.
      try {
        const meta = await projectMetaFromRecord(ctx.fence!, ctx.meta)
        if (meta) await expireSessionKeys(ctx.fence!, code, meta.lifespan)
        const live = await prisma.session.findFirst({ where: { code, deletedAt: null }, select: { id: true, lineupRevision: true } })
        if (live?.lineupRevision != null) await projectLineup(ctx.fence!, await recordLineup(prisma, live.id), live.lineupRevision)
      } catch (err) {
        await scopedInvalidate(code, ctx.meta!.createdAt).catch(e => console.error('[promote] invalidation failed', { code, e }))
        throw err
      }
    })
}

// Re-stamps every `s:{CODE}:*` key to the lifespan's TTL, fenced. Every meta
// write is XX KEEPTTL (mechanism 1), so a lifespan change needs this beside it:
// the settings route and promotion.
export async function expireSessionKeys(fence: Fence, code: string, lifespan?: string): Promise<void> {
  const ttl = lifespanTTL(lifespan)
  const keys = await scanKeys(`s:${code}:*`)
  if (keys.length) await fence.exec(m => { for (const key of keys) m.expire(key, ttl) })
}

// Rewrite a Postgres-backed session's meta FROM THE RECORD (plan § 1.5 / D4) ⊕
// the cache-only `a:` bits of `cache`, XX KEEPTTL, fenced. Every meta write of a
// session with a live row goes through here (after COMMIT for grant-direction
// changes), so a refused or lost projection is repaired by the next one.
export async function projectMetaFromRecord(fence: Fence, cache: SessionMeta | null, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<SessionMeta | null> {
  const row = await readLiveRow(db, fence.code)
  if (!row) return null
  const meta = metaFromRecord(row, await readRecordRoles(db, fence.code), cache)
  await fence.exec(m => { m.set(k.meta(fence.code), JSON.stringify(meta), { XX: true, KEEPTTL: true }) })
  return meta
}

// A "Brought by" REASSIGNMENT, RECORD-FIRST (plan D2), inside the reassign's
// contract: provenance is written on the row (it is never written by an
// ordinary edit); the cache follows as the line-up projection after COMMIT.
// Ownership decides provider edit rights, so the cache must never name an owner
// the record does not. A `u:` target must still have a users row (FOR KEY
// SHARE — account deletion holds it FOR UPDATE). Throws on any refusal; nothing
// commits.
export async function reassignProvenance(tx: Prisma.TransactionClient, sessionId: number, wineId: string, owner: string, ownerName: string): Promise<void> {
  if (owner.startsWith('u:')) {
    const users = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${Number(owner.slice(2))} FOR KEY SHARE`
    if (!users[0]) throw new Error('reassign: target user is gone')
  }
  // Zero rows = the wine's row is not this session's (orphaned by a ban-wipe):
  // the owner change would not persist — refuse.
  const n = await tx.$executeRaw`
    UPDATE wines SET added_by_identity_id = ${owner}, added_by_display_name = ${ownerName.slice(0, 64)}
     WHERE id = ${wineId} AND session_id = ${sessionId}`
  if (n !== 1) throw new Error('reassign: the wine row is not part of this session')
}
