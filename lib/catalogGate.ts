import { hasStaffRole } from '@/lib/staffRole'

// ── catalogGate: the catalogue's kill switch ───────────────────────────────
//
// 🔒 OPEN BY DEFAULT since the catalogue model change (step 4, spec § 7 "The
// fence opens WITH the code"): every new bottle links to an entry, so a closed
// gate would mean only staff could add a bottle at all. The phase-2/3 boundary
// this file used to enforce (no public minting before the review queue) was
// reversed by ruling (Simon, 2026-07-25: negligible volume at current scale);
// its standing condition is met in code instead: every user mint is RECORDED
// as awaiting review in its own transaction (lib/catalogWrite.ts,
// `catalog_review_items`), so nothing minted before phase 3 goes unrecorded.
//
// Three states, deliberately:
//   • unset / anything else              → open to everyone (the default)
//   • CATALOG_PUBLIC_ENABLED=false       → CLOSED: the kill switch (exactly the
//                                          string 'false'). Search, the moment's
//                                          search and entry creation 404 / refuse
//                                          again; adding a bottle then needs staff
//   • staff caller                       → open regardless (curators keep working
//                                          with the switch off)
//
// The env is read at boot by Deplo.io, so flipping it is a restart, not an
// instant change (docs/dev/deployment.md § CATALOG_PUBLIC_ENABLED).

export function catalogPublicEnabled(): boolean {
  return process.env.CATALOG_PUBLIC_ENABLED !== 'false'
}

// May this caller reach the catalog add-flow at all?
//
// 🔒 On the catalogue's own routes a refusal is 404, NEVER 403. A 403 says
// "this exists and you may not use it", which distinguishes staff from
// everyone else — the same leak-prevention rule the API already applies to
// tier-gated profiles (app/api/CLAUDE.md § Status code rules). While the
// switch is off, those endpoints look as if they do not exist. (A bottle add
// that would MINT answers its own refusal instead: the moment route's 404
// means "moment gone" to the clients.)
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
