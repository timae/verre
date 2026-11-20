// The web's label for a blind row from /api/me/ratings
// (`_blind`: the server blanked the identity, lib/outsideView.ts). Applied
// where the rows are fetched, so every render below (the history lists)
// reads it as the name.
export const BLIND_IMPRESSION = 'Blind impression'

export function labelBlind<T extends { _blind?: boolean }>(rows: T[], field: keyof T & string): T[] {
  return rows.map(r => (r._blind ? { ...r, [field]: BLIND_IMPRESSION } : r))
}
