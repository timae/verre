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
import { kindOfStyle } from '@verre/core'

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
  // The record's snapshot kind (lib/occurrences.ts readSnapshots): a sparkling
  // rosé keeps its colour on a blind row too. Absent → the cached token.
  snapshot?: { colour: string | null; sparkling: boolean }
}

export function redactWine(wine: WineMeta, opts: RedactWineOpts): WireWine | null {
  if (opts.revealed) return null
  if (!opts.blindForEveryone && (opts.isHost || opts.ownsWine)) return null
  // 🔒 AN ALLOW-LIST, not a spread (security review r1, catalogue model change
  // step 4): the blind row is built field by field from the few things a taster
  // may know (the id to rate it by, its reveal state, its kind), so a field
  // added to WineMeta later stays OFF a blind row until someone decides it may
  // be on it. The old `...rest` spread leaked every new field by default.
  const kind = opts.snapshot ?? kindOfStyle(wine.type)
  return {
    id: wine.id,
    revealedAt: wine.revealedAt ?? null,
    // 🔒 The catalogue ENTRY is replaced WHOLESALE (catalogue model change § 0.3):
    // its ids, name, producer, grapes, region and any catalogue photo are all
    // label identity, and so are the flat ids (a productId is a lookup oracle:
    // the catalogue is deliberately public, RFC ruling 3). None on a blind row.
    entry: null,
    // 🔒 `colour` and `sparkling` STAY, as the style always did: the structure
    // wheel needs them (Bubbles on a blind sparkling wine), and they are what a
    // pour shows anyway. The abv does NOT (ruled 2026-11-20, Simon): no number
    // and no alcohol-free mark before the reveal (a legacy `nonalc` token reads
    // as "neither", like an entry with no colour).
    colour: kind.colour,
    sparkling: kind.sparkling,
    abv: null,
    name: `Wine ${opts.index + 1}`,
    producer: '',
    vintage: '',
    grape: '',
    // The UI mystery slot keys on `_blind`, never on the kind.
    image: '',
    imageUrl: '',
    description: '',
    region: '',
    country: '',
    vinification: '',
    purchaseUrl: '',
    isMine: false,
    addedByDisplayName: null,
    addedByUserId: null,
    _blind: true,
  }
}
