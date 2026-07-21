import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';

// Typed fetcher + wire type for the canonical wine product page
// (GET /api/wines/[productId]). Mirrors the server shape in
// app/api/wines/[productId]/route.ts — the server is the source of truth;
// this hand-mirrors it per the web↔native wire-type convention.
export type WineProduct = {
  id: string;
  name: string;
  producer: string | null;
  vintage: string | null;
  grape: string | null;
  category: string;
  // `style` column, named `type` to match the WineIdentity / feed vocabulary.
  type: string | null;
  // Raw ISO 3166-1 alpha-2 — resolve to a name via @verre/core countryName.
  country: string | null;
  region: string | null;
  vinification: string | null;
  description: string | null;
  imageUrl: string | null;
  community: {
    avgScore: number | null;
    ratingCount: number;
    tastingCount: number;
    tasterCount: number;
    // Score-weighted structure-axis means; null for a never-tasted axis.
    flavors: Record<string, number | null>;
    // Per-node taster frequency; roll up to family via @verre/core at render.
    aromas: { node: string; count: number }[];
  };
};

export async function getWineProduct(productId: string): Promise<WineProduct> {
  const res = await apiFetch(`/api/wines/${encodeURIComponent(productId)}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}
