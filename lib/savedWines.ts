// The Saved wire (GET /api/me/bookmarks, catalogue model change § 5): one wine
// with the vintages you saved of it and your ratings of it as context. Pure,
// client-safe; shared by /me/saved, its modal and the dashboard.
export type SavedVintage = {
  key: string                // DELETE /api/me/bookmarks/<key> removes this one
  vintage: string | null     // '2019', 'NV', or null = this wine, any year
  saved_at: string
  session_id: number | null
  session_code: string | null
  session_deleted: boolean
}
export type SavedRating = {
  id: number
  score: number | null
  flavors: Record<string, number>
  notes: string | null
  rated_at: string
  vintage: string | null
  session_id: number | null
  session_code: string | null
  session_deleted: boolean
}
export type SavedWine = {
  key: string
  name: string
  producer: string | null
  grape: string | null
  style: string | null
  colour: string | null
  sparkling: boolean
  abv: number | null
  category: string
  image_url: string | null
  purchase_url: string | null
  saved_at: string
  linked: boolean            // false: no catalogue link, so nothing is known of its years
  vintages: SavedVintage[]
  ratings: SavedRating[]
}

export const vintageLabel = (v: string | null, linked = true): string => v ?? (linked ? 'any year' : '')
export const vintagesLabel = (w: Pick<SavedWine, 'vintages' | 'linked'>): string =>
  w.vintages.map(v => vintageLabel(v.vintage, w.linked)).filter(Boolean).join(' · ')
