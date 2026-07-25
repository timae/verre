// Per-wine redaction for blind tastings (rewire.md §3 / phase 1.5).
//
// Extracted from app/api/session/[code]/wines/route.ts so phase 2's
// feed-read path can apply the same rule to wines surfaced through
// `feed_items`. Pre-rewire only the live-session wines GET applied
// redaction; post-rewire the Tastes tab + the feed both render
// blind-session wines too, and they MUST use this helper or the
// blind invariant leaks.
//
// Decision logic (returns null = "show full, no redaction"):
//   - opts.revealed true → null (wine is revealed to all tasters).
//     Reveal is the deliberate "show this to everyone" action and
//     always wins, even over blindForEveryone.
//   - opts.blindForEveryone true → never bypass on isHost/ownsWine. The
//     host opted into "nobody sees the lineup, including me."
//   - opts.isHost true → null (host bypass — sees everything).
//   - opts.ownsWine true → null (provider self-view exception:
//     providers see their own wines un-redacted even while blind
//     to other contributors').
//   - Otherwise → WireWine stub with name="Wine N", identifying
//     fields blanked. `_blind=true` so the UI can render the
//     mystery placeholder.
//
// The returned shape matches `WireWine` directly so callers don't
// double-transform. Provenance and snapshot fields are stripped
// (a blind taster knowing "Alice brought this" partially identifies
// the wine via known preferences).

import type { WineMeta, WireWine } from '@/lib/session'

export type RedactWineOpts = {
  revealed: boolean
  isHost: boolean
  ownsWine: boolean
  index: number
  // Per-session "Blind for all" flag. When true, the host/cohost/
  // provider/wine-adder bypasses are disabled — only `revealed`
  // un-redacts. Composes with meta.blind (callers gate this whole
  // helper on meta.blind first).
  blindForEveryone?: boolean
}

export function redactWine(wine: WineMeta, opts: RedactWineOpts): WireWine | null {
  if (opts.revealed) return null
  if (!opts.blindForEveryone && (opts.isHost || opts.ownsWine)) return null
  const { addedByIdentityId: _provenance, addedByDisplayName: _snapshot, ...rest } = wine
  return {
    ...rest,
    name: `Wine ${opts.index + 1}`,
    producer: '',
    vintage: '',
    grape: '',
    // `type` (the STYLE: red/white/spark/rose) is NOT masked. Style is not
    // identity — a taster holding the glass already sees/tastes that it's
    // sparkling vs still; name/producer/vintage/grape/region (above + below)
    // are what identify the wine, and those stay blank. Passing the real style
    // through lets the structure wheel offer the right axes (e.g. Bubbles on a
    // blind sparkling wine) — the UI mystery slot keys on `_blind`, not `type`.
    // (Was forced to 'red' for the old descriptor detectFL; no longer needed.)
    image: '',
    imageUrl: '',
    description: '',
    region: '',
    country: '',
    vinification: '',
    purchaseUrl: '',
    // 🔒 CATALOG IDS ARE LABEL IDENTITY — stripping them is not optional.
    // A productId in a blind payload is a lookup oracle: the catalog is
    // deliberately public (RFC ruling 3), so one GET against it turns the
    // id straight back into the producer, name, and vintage that every
    // other field here is blanking. It identifies the wine as precisely as
    // `name` does, and must be treated exactly like it.
    //
    // ⚠️ These two lines are load-bearing BECAUSE of the `...rest` spread
    // above: WineMeta fields flow through by default, so a redaction that
    // simply forgot them would leak silently — the payload would still
    // look correctly masked in every visible field. Any future identifying
    // field added to WineMeta needs the same treatment.
    productId: null,
    vintageId: null,
    isMine: false,
    addedByDisplayName: null,
    addedByUserId: null,
    _blind: true,
  }
}
