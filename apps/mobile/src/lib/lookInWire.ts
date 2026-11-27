// The look-in's wire shapes (Moment Visibility step-2 plan § 3; MIRROR
// lib/momentLookIn.ts on the server, keep in sync by hand). Types only and no
// imports, so the pure modules unit-tested from the repo root
// (lib/lookInCompare.ts) can share them without pulling React Native's typings
// into the web build. lib/api/moments.ts re-exports them.
export type LookInAroma = { a: string; m: string | null; p?: true };
export type LookInPerson = {
  // Stable: a registered person's public id; a guest's `g` + 15 hex.
  key: string;
  id?: string; // the public id (registered people only)
  name: string;
  imageUrl: string | null;
  guest?: true;
};
type BottleHead = { key: string; position: number; avg: number | null; count: number; colour: string | null; sparkling: boolean };
export type LookInBlindBottle = BottleHead & { blind: true };
export type LookInOpenBottle = BottleHead & {
  blind?: undefined;
  name: string;
  producer: string | null;
  vintage: string | null;
  grape: string | null;
  abv: number | null;
  imageUrl: string | null;
  region: string | null;
  country: string | null;
  vinification: string | null;
  description: string | null;
  purchaseUrl: string | null;
  broughtBy: { id: string; name: string } | null;
};
export type LookInBottle = LookInBlindBottle | LookInOpenBottle;
// The first read's rating: what Compare's cards and a bottle's page show.
export type LookInLightRating = { person: string; bottle: string; score: number | null; flavors: Record<string, number>; hasAromas?: true };
// The details read's rating: an opened Compare card's aromas (named people who have any).
export type LookInAromaRating = { person: string; aromas: LookInAroma[] };
export type LookInMoment = {
  id: string;
  name: string | null;
  coverPhotoUrl: string | null;
  category: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  blind: boolean;
  timezone?: string | null;
  address?: string | null;
  description?: string | null;
  link?: string | null;
  host: { id: string; name: string; imageUrl: string | null } | null;
  lineupRevealsAt?: string;
};
export type LookIn = {
  member: false;
  moment: LookInMoment;
  lineupHidden: boolean;
  lineup: LookInBottle[];
  people: { total: number; named: LookInPerson[]; more: number };
  ratings: LookInLightRating[];
};
// Every asked bottle still in the line-up is answered (with or without aromas).
export type LookInDetails = { member: false; bottles: { key: string; ratings: LookInAromaRating[] }[] };
// The caller is in the moment: open the moment itself (getMomentMembership).
export type LookInMember = { member: true };
