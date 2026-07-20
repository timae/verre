# "Change who brought each impression" — ownership-transfer concurrency

**Status: SHIPPED as a deliberately BOUNDED v1** (Simon's scope ruling,
2026-07-20). The v1 lives within the repo's existing best-effort Redis→PG
archival contract — NO schema migration, NO outbox, NO drain/job, NO distributed
transaction. The "durable outbox + conditional-write" design in the lower half of
this doc is the road NOT taken — kept as the rationale-of-record for what
STRONGER consistency would cost, to be funded as its own project only if the
bounded residual proves unacceptable.

## Shipped bounded-v1 contract (what actually exists)

- **Ownership-only request.** A `PATCH /wines/[wineId]` carrying
  `broughtByIdentityId` may carry NOTHING else (no name/producer/type/image/…);
  a mix is 400. The client sends field edits and the reassign as SEPARATE saves.
  This keeps the reassign critical section S3-free + tiny.
- **Host/cohost only**, re-authorized against FRESH meta INSIDE the ban lock
  (a demotion before the lock is caught). Providers rejected. Rejected when
  `showProvenance` is off (the control is also hidden client-side then).
- **Ownership-only enforced by a STRICT allowlist** — the body may contain ONLY
  `broughtByIdentityId`; any other key (known field or unknown) → 400. Stays
  correct as new wine fields are added.
- **Serialized under the ban lock** (`s:{code}:lock:ban`) — the same lock the
  ban endpoint holds across `sessionWipe`, the role endpoint holds for role
  writes, and (new) the wine DELETE holds. Target re-validated (membership +
  not banned/kicked) inside the lock. **The wine DELETE ALSO re-authorizes
  inside its lock** (re-reads meta + the wine's CURRENT owner) — its pre-lock
  provider/host check can go stale if a reassign or a cohost demotion lands
  before the lock (a no-longer-owner provider must not delete).
- **Limited to ALREADY-ARCHIVED sessions (Simon, 2026-07-20).** The reassign is
  gated on `pgSessionExists(code)` INSIDE the lock, BEFORE any Redis write. If no
  live PG session row exists — a pure Redis-only anon moment (root CLAUDE.md:
  anon sessions stay Redis-only) — it **rejects 409 and mutates nothing**. It does
  NOT force-archive the session (that would break the anon lifecycle contract)
  and does NOT allow a Redis-only ownership change (that would reintroduce the
  first-archival provenance race when a logged-in participant later archives from
  a stale snapshot). **Bounded-v1 limitation:** attribution can't be changed on a
  moment no signed-in guest has archived yet. (An earlier fix force-archived on
  reassign — reverted; it silently changed the anon-Redis-only data-lifecycle
  contract, which needs a product ruling, not an internal fix.)
- **Redis first, then synchronous PG mirror** (`pgReassignWineProvenance`): an
  UPSERT of the wine row with provenance FORCED on both create and update. It
  NEVER archives a session as a side effect (the 409 gate ensured one existed).
  That gate is a pre-check, not a guarantee — session delete / account cleanup
  don't hold the ban lock, so the row can vanish TOCTOU between the gate and the
  mirror; the mirror THROWS in that case (not a silent no-op) so the Redis
  compensation runs and the route 500s, never leaving Redis-new / PG-gone.
  Forcing the wine upsert (rather than a provenance-only update that could no-op
  if the wine row is absent while the session row exists)
  means the new owner always lands, and every later `pgUpsertWine` freezes
  provenance on update → keeps it. On PG failure, **COMPENSATE**: restore the
  prior provenance in Redis, return 500. The client retries the idempotent
  ownership request ONCE.
- **Ordinary PATCH preserves current provenance** inside its `mutateWines`
  transform (reads `current[i]`, not the pre-read snapshot) so an ordinary edit
  can't silently revert a concurrent reassignment — AND builds its response +
  PG mirror from the ACTUALLY-WRITTEN wine (`out[i]`), so a concurrent reassign
  can't make the PATCH echo a stale owner / `isMine`.
- **Known bounded asymmetry:** the ordinary PATCH's provider own-wine check is
  pre-write and unlocked (unlike DELETE). A provider whose wine was reassigned
  away could still land a field edit on it — accepted: it's a non-destructive,
  non-ownership edit, and locking every ordinary provider edit exceeds the v1
  scope. Only DELETE (destructive) gets the in-lock re-auth.
- **Accepted residual (documented, within the existing contract):** a process
  crash / lock expiry / double-failure (PG write fails AND the compensating
  Redis restore also fails) can leave archival drift — Redis holds the new
  owner, PG the old. Self-corrects on the next reassign of that wine; Redis
  stays the live-authorization source throughout. This is the SAME best-effort
  class as every other `pgUpsertWine` in the codebase; the v1 does not claim to
  eliminate it, only to bound it (compensation + one retry).

Everything below is the ORIGINAL (unshipped) stronger-consistency design,
retained for context. Do not read it as describing what's built.

---

## Original problem framing (unshipped design follows)

## Problem

A host/cohost can reassign a wine's bringer (`PATCH /wines/[wineId]` with
`broughtByIdentityId`), rewriting `wines.addedByIdentityId` +
`addedByDisplayName`. That field is not a display label — it is the **ownership
anchor** for provider edit/delete rights, the ban-sweep filter, and the
blind-feed bypass. So a reassignment is a real authorization mutation on state
shared with several other writers, replicated across **two stores** (Redis =
live source of truth; Postgres = archival mirror read by feed / profile / HoF).

Three review rounds surfaced that patching the write ordering does not converge:
each fix (validate-before-S3, S3-outside-lock, PG-before-Redis, re-auth-in-lock)
shifted the failure rather than removing it, because the requirements interlock
and a fixed-TTL mutex cannot provide a cross-store transaction.

## What must be true (invariants)

1. **No S3 side effect on a rejected reassign.** A reassign that fails auth /
   membership / visibility must not have uploaded, reclaimed, or overwritten the
   wine image.
2. **The two stores must not durably disagree on ownership.** The unrepairable
   split is *Redis-moved / PG-stale*: live auth uses the new owner while feed/HoF
   and a ban's PG orphan step use the old one, and **no ordinary edit repairs
   it** (ordinary PATCH freezes provenance). A transient split is tolerable ONLY
   if a defined mechanism converges it.
3. **Ownership writes must serialize with the ban wipe.** `sessionWipe` deletes
   wines by `addedByIdentityId`; a reassign interleaving it can plant a
   banned-owner wine or leave a store-torn delete.
4. **A concurrent ordinary edit must not silently revert a reassignment.**
5. **A lease that expires mid-write must not corrupt state**, and its release
   must not delete a different holder's lease.

## Inventory: every path that writes `addedByIdentityId` / `addedByDisplayName`

| Path | Redis write | PG write | Currently locked? | Ownership hazard |
|---|---|---|---|---|
| **Reassign PATCH** (new) | `mutateWines` splice | `pgUpsertWine(…, reassign=true)` | ban lock (this design) | the subject of this doc |
| **Ordinary PATCH** | `mutateWines` splice of a `result` built from `wines[idx]` read BEFORE the transform | `pgUpsertWine(…, reassign=false)` — freezes provenance | no | **clobbers a concurrent reassign**: splices stale provenance; the WATCH retry re-runs the transform but re-inserts the already-built `result`, not a re-read provenance |
| **Wine DELETE** | `mutateWines` filter | `prisma.wine.delete` | no | races reassign PG-vs-Redis → PG-only orphan or Redis-404 |
| **Session wipe** (kick/ban) | `mutateWines` filter (`deleteAddedWines`) | `deleteMany` / orphan | ban lock (held across whole wipe) | already correct; the others must join its lock |

**Conclusion:** correctness is a property of the whole *set* of writers, not of
the reassign handler alone. Ordinary PATCH and DELETE must join the protocol
(preserve-current-provenance and/or lock), or reassign can be reverted/torn no
matter how carefully its own ordering is written.

## Corrected architecture (established from the code, round 4)

The earlier "two peer stores that must be transactionally consistent" framing
was WRONG. Verified against `lib/sessionState.ts` + the two-tier model:

- **The live session reads wine ownership ONLY from Redis** (`buildWinesView` →
  `getWines`). Postgres is NEVER the live-authorization read path.
- **Postgres is incremental, best-effort archival.** A wine's PG row exists only
  AFTER a logged-in user triggers archival (rate / visit / add); it can be
  wholly absent for a live anon session. EVERY `pgUpsertWine` call in the
  codebase is `try/catch {}` — the PG mirror is *already* eventually-consistent-
  at-best for ALL fields, not just provenance.
- **Redis is NOT durably authoritative — it EXPIRES** (48h+ TTL). So "Redis
  authoritative + reconcile PG from Redis" is unsound (Codex P2): the recovery
  source vanishes. A periodic Redis→PG sweep cannot converge a reassignment made
  shortly before Redis expiry.

**Consequence:** the cross-store consistency Codex is (correctly) holding the bar
to is a property of the *whole archival model*, which is best-effort by design
and predates this feature. Reassign does NOT introduce a general distributed-
transaction requirement. It introduces exactly ONE new hazard the rest of the
model doesn't have:

> **The reassign-specific bug:** `pgUpsertWine`'s UPDATE path FREEZES provenance
> (`existing ?? …`). So unlike name/producer/region (which a later edit
> re-mirrors and thus self-heals a missed archival write), a reassignment that
> fails to reach PG is **never repaired by any subsequent write** — the frozen
> field stays stale forever. That non-self-healing property is the real defect,
> and it's durable-store-independent.

## Design decisions to settle (this is what needs approval)

### D1 — Durable repair record (outbox), NOT a Redis-sourced sweep

Per Codex ruling #1 (reject periodic reconciliation; the recovery source must
survive Redis expiry): the repair record must be **durable and self-contained**,
carrying the new owner id+name itself so it doesn't depend on Redis still
existing.

**Proposal — a tiny durable outbox row, written in the SAME Postgres transaction
as the wine-provenance update:**
- New table `wine_provenance_outbox(wine_id, session_code, new_identity_id,
  new_display_name, applied_at NULL)`.
- The reassign's PG write is a single transaction: `UPDATE wines SET
  addedBy… = new` **plus** an outbox row. Both commit or neither.
- If the wine's PG row doesn't exist yet (anon session pre-archival), the outbox
  row still commits with the owner data; when archival later creates the wine
  row (rate/visit), an outbox-drain applies the pending owner before clearing
  `applied_at`. This survives Redis expiry because the owner data lives in the
  durable outbox, not in Redis.
- A drain (on the next archival touch of that wine + a low-frequency backstop
  job) applies unapplied rows. Idempotent: applying the same owner twice is a
  no-op.

This makes PG the DURABLE record of the *intended* ownership even when Redis is
gone, satisfying invariant 2 without a distributed transaction across Redis+PG:
the Redis write and the PG-txn(update+outbox) are still two steps, but a failure
of either is now *recoverable from a durable source* rather than lost.

### D2 — Lease-expiry corruption needs a CONDITIONAL write, not just a lease

Per Codex P1: a CAS-release lease does NOT stop an expired holder from writing
stale state (validate B → lease expires → successor bans B → stale handler
assigns to now-banned B). A lease cannot fix this; only making the WRITE ITSELF
conditional on still-valid state can.

**Proposal — the ownership write re-checks ban/kick state ATOMICALLY at commit,
and the outbox drain re-validates on apply:**
- The Redis ownership write moves into a `mutateWines` transform that ALSO
  WATCHes `s:{c}:bans` + `s:{c}:identities` (extend `mutateWines` to accept
  extra WATCH keys), and the transform re-reads the target's membership/ban
  state and returns a `MutateReject` if the target is now banned/kicked/absent.
  Because WATCH aborts the MULTI if any watched key changed, a ban that lands
  between the read and the commit forces a retry that then sees the ban and
  rejects. **This makes a stale resumed handler's write no-op by construction —
  no lease/fence required.**
- The outbox drain likewise re-validates the target against the (durable) ban
  record before applying, so a queued reassignment to a since-banned target is
  dropped, not applied. → Reconciliation does NOT "copy corrupted state" (Codex
  P2 sub-point); it re-checks first.

This replaces the whole "lease must outlive the section" reasoning: correctness
comes from conditional writes, and the lease is reduced to a best-effort
*throughput* optimization (avoid wasted WATCH-retry churn), not a correctness
mechanism. If we keep the lease at all, its release is CAS'd; if it expires,
nothing corrupts because the writes are conditional.

### D3 — Reassign forbids a same-request image change

To keep the leased section S3-free (D2) and satisfy invariant 1 without the
validate-vs-S3-ordering paradox: **the server rejects a PATCH that carries BOTH
`broughtByIdentityId` AND an image change (`image` present).** The client sends
them as two PATCHes (image edit, then reassign, or vice-versa). Rationale: image
edit and ownership transfer are independent operations; coupling them is what
forced S3 into the ownership-critical path. Cheap client change; removes the
whole S3-in-lock problem class.

### D4 — Ordinary PATCH + DELETE join the protocol (Codex ruling #3: mandatory)

- **Ordinary PATCH** must preserve the *current* provenance read INSIDE the
  `mutateWines` transform, not the `result` built from the pre-transform
  `wines[idx]` snapshot. The transform runs on the freshly-WATCHed `current`
  array, so `next[i] = { ...result, addedByIdentityId: current[i].addedByIdentityId,
  addedByDisplayName: current[i].addedByDisplayName }` — the edit keeps its field
  changes but never overwrites an ownership value a concurrent reassign just
  committed. (Invariant 4. This is the fourth ownership-writer Codex surfaced;
  without it, an ordinary edit racing a reassign silently reverts it regardless
  of any lock the reassign holds, because the edit doesn't take the lock.)
- **Wine DELETE** joins the lease so a reassign and a delete of the same wine
  serialize; and the reassign's `mutateWines` transform rejects (wine absent) if
  the delete won, so no PG-only orphan (invariant 3, DELETE arm).

## Failure-mode table (target behaviour, revised round 4)

| Failure | Outcome |
|---|---|
| Reassign fails auth/membership/visibility | 4xx, **no** Redis/PG/S3 change (validation precedes all writes; no image in body per D3) |
| Reassign Redis write commits, PG-txn(update+outbox) fails | 500; Redis moved but the durable owner intent is NOT lost — the NEXT archival touch (or backstop drain) re-applies from the outbox. Live auth (Redis) correct throughout. If Redis expires before the drain, the outbox STILL carries the durable intent → applied on the wine row's archival |
| Lease expires mid-section, successor bans the target, stale handler resumes | The Redis write is a `mutateWines` transform WATCHing bans/identities → the ban changed the watched key → MULTI aborts → retry sees the ban → **rejects** (no assign-to-banned). The outbox drain re-validates too. Corruption impossible **by construction**, not by lease timing (Codex P1 closed) |
| Concurrent ban wipe | serialized by the lease AND, independently, the conditional write rejects a banned target |
| Concurrent ordinary edit | can't clobber — ordinary PATCH preserves `current[i]` provenance INSIDE the transform (D4), so a reassign committed first survives |
| Concurrent DELETE | DELETE joins the lease; and a reassign whose wine was deleted sees `mutateWines` reject (wine absent) → 404, no PG-only orphan |
| PG-only row (wine in PG, absent from Redis) | Distinguished by session liveness: if `s:{code}:meta` exists the session is live (Redis is truth, PG stale → drain/repair); if meta is gone the session expired (PG is the archive of record). The DELETE + expiry cases are disambiguated by meta-existence, not guessed |

## Open questions — Codex's rulings folded in

Codex ruled on the round-3 questions; carrying them forward:

1. ✅ **Reject periodic reconciliation** → **D1 durable outbox** (owner data
   survives Redis expiry). — *Adopted.* Confirm the outbox table + drain is the
   shape you want (vs. an alternative durable record).
2. ✅ **Approve D3** (forbid image+reassign in one request). — *Adopted.*
3. ✅ **D4 in scope** (ordinary PATCH + DELETE must join the protocol). —
   *Adopted; it's mandatory, not optional.*
4. ✅ **Reject the logged-in-host escape hatch** as a correctness solution (two
   sequential writes still split). — *Removed from the design.*

**Remaining decision for you — the real scope question this raises:** the sound
design is now materially bigger than "a reassign handler" — it needs a new
Postgres table + migration, a `mutateWines` extension to WATCH extra keys, a
drain hooked into the archival path + a backstop job, and changes to the ordinary
PATCH + DELETE handlers. That is a **schema + shared-primitive + cross-handler**
change. Two honest paths:

- **(A) Build the full sound design** as its own change (schema migration +
  outbox + conditional writes + D4). Correct, but a real project — arguably its
  own PR separate from the "Moment Setup / showProvenance" work already done.
- **(B) Ship the feature WITHOUT server-side reassignment for now.** The
  "Moment Setup / show-who-brought-it" toggle + the brought-by DISPLAY are done,
  reviewed, and sound. The *reassign* control is what dragged in the distributed-
  write problem. We could land the display/toggle now and split reassignment
  into its own tracked piece built from this proposal — rather than block the
  shipped, correct work behind an unsolved concurrency design.

My honest recommendation is **(B)**: the reassignment feature has an irreducible
distributed-consistency core that deserves to be built deliberately from an
approved design, not wedged into the current branch under review pressure. The
already-correct display + toggle shouldn't wait on it.

## Test plan (there is currently NO coverage — Codex flagged this)

`.local/test-env/` harness (no jest/vitest): drive real Redis+PG through the
actual handlers. MUST include the defining concurrency failures (Codex P3):
- reassign happy path (logged-in + anon target)
- **lease expiration → successor bans target → stale-holder write rejects** (not
  applied to banned target)
- **Redis expiry before the outbox drain** → owner still applied from the durable
  outbox on the wine's next archival
- **second-store (PG-txn) write failure** → re-applied from outbox, not lost
- reassign vs ban wipe (serialized + conditional-reject)
- reassign vs ordinary edit (no-clobber, provenance preserved in transform)
- reassign vs DELETE (no PG-only orphan; meta-existence disambiguation)
- provider rejected; hidden-provenance rejected; non-participant/banned target
  rejected
