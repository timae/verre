// Shared wire types for session feed_items — surfaced both on the
// social feed (`/api/feed`) and on profile pages (`lib/profileLoad.ts`).
// Kept here so the API and the UI can't drift on the per-wine shape.

// One wine the author rated in a session, as it appears inside a
// SessionFeedCard. Either a fully visible wine OR a redacted blind
// placeholder. Use `_blind: true` on the redacted variant so the UI
// can render the mystery slot the same way the live session view does.
export type SessionFeedWine = {
  // Postgres `wines.id` (string nanoid). Stable across renders.
  id: string
  // Identity fields, blanked out when blind & not yet revealed.
  name: string
  producer: string | null
  vintage: string | null
  grape: string | null
  // Maps from `wines.style` ('red' | 'white' | 'spark' | 'rose' | 'nonalc' …).
  // Kept as `type` to match the existing CheckinCard / WineIdentity vocabulary.
  type: string | null
  // Image priority: rating photo first, falling back to the wine's
  // canonical bottle shot. Null when neither is set OR when blind-redacted.
  imageUrl: string | null
  // The author's rating data — always visible, never redacted (it's
  // their own data, even on a blind wine they've rated).
  score: number | null
  flavors: Record<string, number>
  notes: string | null
  // Set when the wine is blind-redacted. UI renders the mystery card
  // and skips identity-bearing fields.
  _blind?: boolean
}

// The session-feed payload, replacing the phase-2 `'session_stub'` shape.
// Tombstoned sessions (`deleted: true`) still ship the per-wine list —
// only the session-level identity (sessionName + hostName) scrubs to
// null. The renderer shows "[deleted session]" in the header and renders
// the wines below. The blind-redaction predicate short-circuits on
// `deleted`, so a post-delete blind tasting reveals wine identity
// regardless of `revealedAt` — accepted trade-off (host who deletes
// has authorised the reveal; participants engaged with the wine).
export type SessionFeedPayload = {
  id: number              // feed_items.id
  sessionId: number | null
  sessionName: string | null
  hostName: string | null
  deleted: boolean
  blind: boolean
  wines: SessionFeedWine[]
  likeCount: number
  liked: boolean
}
