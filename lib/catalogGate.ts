import { hasStaffRole } from '@/lib/staffRole'

// ── catalogGate: the phase-2/phase-3 release boundary, enforced ────────────
//
// 🔒 PHASE 2 AND PHASE 3 GO PUBLIC TOGETHER. Phase 2 (this code) lets a user
// mint catalog entries; phase 3 builds the review queue that confirms, merges,
// or rejects them. The implementation plan's release boundary is explicit about
// why they cannot ship separately:
//
//   an UNREVIEWED PROVISIONAL is a valid steady state, whereas PUBLICLY
//   SEARCHABLE USER-AUTHORED CONTENT WITH NO MODERATION PATH is not.
//
// If phase 3 slips there is no supported way to handle abuse, junk, duplicate
// accumulation, or mistaken entries — and "phase 3 is next" is sequencing
// intent, not an operational guarantee. So the switch below defaults CLOSED and
// the boundary is a runtime gate rather than a note in a doc.
//
// Three states, deliberately:
//   • unset / anything but 'true'  → closed to the public (the default)
//   • staff caller                 → open regardless, so the flow can be
//                                    dogfooded and tuned before it is public
//   • CATALOG_PUBLIC_ENABLED=true  → open to everyone (flip in phase 3)
//
// The staff bypass is what makes early matcher tuning possible without opening
// public creation: per the plan, useful tuning signal comes from CURATOR
// DECISIONS (same/distinct verdicts), not from raw search activity. A limited
// external cohort is reachable by flipping the env var for one deploy — that is
// the plan's "expose it to a limited cohort behind a kill switch".

export function catalogPublicEnabled(): boolean {
  return process.env.CATALOG_PUBLIC_ENABLED === 'true'
}

// May this caller reach the catalog add-flow at all?
//
// 🔒 A REFUSAL MUST BE 404, NEVER 403. A 403 says "this exists and you may not
// use it", which advertises an unreleased surface and distinguishes staff from
// everyone else — the same leak-prevention rule the API already applies to
// tier-gated profiles (app/api/CLAUDE.md § Status code rules). While the switch
// is off, the endpoint should be indistinguishable from one that does not
// exist.
//
// `userId` must come from the authenticated server context, never a request
// body (root CLAUDE.md § Trust model). Anonymous callers pass null and are
// gated on the env switch alone — they can never be staff.
export async function canUseCatalog(userId: number | null): Promise<boolean> {
  if (catalogPublicEnabled()) return true
  if (!userId) return false
  // Fresh DB read every time, never cached — revocation must be immediate
  // (lib/staffRole.ts). 'curator' is the floor; admin implies curator.
  return hasStaffRole(userId, 'curator')
}
