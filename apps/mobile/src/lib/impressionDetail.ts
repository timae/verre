import type { AromaSelection } from '@verre/core';

// The impression page's data in the opened post's standalone layout (Moment
// Visibility step 3, R4, T13): one page, the rating's own key (`ratingId`, the
// row's key), and NO post-level parts (no moment, no place, no post id).
// STRUCTURAL types on purpose (lib/listPost.ts's rule: the root units import
// this module); the input is lib/api/lists.ts `ImpressionPage`, the output fits
// `detailFromItem`'s (lib/api/feed.ts).
type ImpressionPageLike = {
  id: number;
  author: { id: string; name: string; username?: string | null; xp: number; imageUrl: string | null };
  wineId?: string;
  name: string; producer: string | null; vintage: string | null; grape: string | null; type?: string | null; category?: string;
  colour: string | null; sparkling: boolean; abv: number | null; imageUrl: string | null;
  score: number | null; flavors: Record<string, number>; aromas: AromaSelection[]; notes: string | null;
  region: string | null; country: string | null; vinification: string | null; description: string | null; purchaseUrl: string | null;
  hadAt: string; blind?: true;
};
export type ImpressionWine = {
  ratingId: number; id?: string; name: string; producer: string | null; vintage: string | null; grape: string | null;
  colour: string | null; sparkling: boolean; abv: number | null; imageUrl: string | null; score: number | null;
  flavors: Record<string, number>; aromas: AromaSelection[]; notes: string | null; region: string | null; country: string | null;
  vinification: string | null; description: string | null; purchaseUrl: string | null; _blind?: boolean;
};
export type ImpressionDetail = {
  author: { id: string; name: string; xp: number; imageUrl: string | null };
  wines: ImpressionWine[];
  isSession: false;
  createdAt: string;
  verb: string;
  place: null;
  momentName: null;
  sessionId: null;
  momentId: null;
};

export function impressionDetail(p: ImpressionPageLike): ImpressionDetail {
  return {
    author: { id: p.author.id, name: p.author.name, xp: p.author.xp, imageUrl: p.author.imageUrl },
    wines: [{
      ratingId: p.id,
      ...(p.wineId ? { id: p.wineId } : {}),
      name: p.name,
      producer: p.producer,
      vintage: p.vintage,
      grape: p.grape,
      colour: p.colour,
      sparkling: p.sparkling,
      abv: p.abv,
      imageUrl: p.imageUrl,
      score: p.score,
      flavors: p.flavors ?? {},
      aromas: p.aromas ?? [],
      notes: p.notes,
      region: p.region,
      country: p.country,
      vinification: p.vinification,
      description: p.description,
      purchaseUrl: p.purchaseUrl,
      ...(p.blind ? { _blind: true } : {}),
    }],
    isSession: false,
    createdAt: p.hadAt,
    verb: 'had a wine',
    place: null,
    momentName: null,
    sessionId: null,
    momentId: null,
  };
}
