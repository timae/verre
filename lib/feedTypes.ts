// Shared wire types for session feed_items — surfaced both on the
// social feed (`/api/feed`) and on profile pages (`lib/profileLoad.ts`).
// Kept here so the API and the UI can't drift on the per-wine shape.

// One wine the author rated in a session, as it appears inside a
// SessionFeedCard. Either a fully visible wine OR a redacted blind
// placeholder. Use `_blind: true` on the redacted variant so the UI
// can render the mystery slot the same way the live session view does.
export type SessionFeedWine = {
  // The author's rating row (`ratings.id`): on EVERY row, and the key clients
  // use for lists and for finding a row. It only links one person's own rows
  // to each other.
  ratingId: number
  // Postgres `wines.id` (string nanoid). 🔒 ABSENT on a blind row unless the
  // viewer wrote that rating (their Edit / Delete Rating need it): a blind
  // bottle's id is label identity for anyone else (an old photo key fetches
  // the label, and the id joins the row to other surfaces).
  id?: string
  // Identity fields, blanked out when blind & not yet revealed.
  name: string
  producer: string | null
  vintage: string | null
  grape: string | null
  // Maps from `wines.style` ('red' | 'white' | 'spark' | 'rose' | 'nonalc' …).
  // Kept as `type` for the app until its build (catalogue model change step 7).
  // Name / producer / vintage / grape / region / country come from the
  // catalogue entry when the bottle is linked (merges followed), else its
  // snapshot (step 5).
  type: string | null
  // The bottle's kind (its snapshot): the axes read `sparkling` (catalogue
  // model change step 4). Stay on a blind row, like the style always did; the
  // abv does not (null on a blind row, ruled 2026-11-20).
  colour: string | null
  sparkling: boolean
  abv: number | null
  // Image priority: rating photo first, falling back to the wine's
  // canonical bottle shot. Null when neither is set OR when blind-redacted.
  imageUrl: string | null
  // The author's rating data — always visible, never redacted (it's
  // their own data, even on a blind wine they've rated). `aromas` rides
  // with score/flavors/notes: descriptor selections are the taster's own
  // perception, never wine identity (aroma-layer.md §7 — no blind fork).
  score: number | null
  flavors: Record<string, number>
  aromas: { a: string; m: string | null; p?: boolean }[]
  notes: string | null
  // Wine-catalog metadata for the full impression detail page (mobile
  // feed → "About this impression": Origin · Variety · Process + buy).
  // `grape` above is Variety. `country` is the raw ISO 3166-1 alpha-2
  // code — the CLIENT resolves it to a name via @verre/core `countryName`
  // (matches the 02e WineInfoPane), so the wire stays the raw column.
  // ALL of these blank to null on a blind-redacted wine — they flow
  // through the same redaction fork as name/producer, so identity never
  // leaks before reveal.
  region: string | null
  country: string | null
  vinification: string | null
  description: string | null
  purchaseUrl: string | null
  // Set when the wine is blind-redacted. UI renders the mystery card
  // and skips identity-bearing fields.
  _blind?: boolean
  // The signed-in viewer's save state (lib/cravings.ts savedFlags): on a
  // redacted row only their save of THAT bottle, never whether they crave the
  // wine (catalogue model change § 5). Absent for a signed-out viewer.
  saved?: boolean
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
