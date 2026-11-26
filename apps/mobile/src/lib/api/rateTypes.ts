// The rating wire types, DEPENDENCY-FREE (no React Native, no Expo, no
// apiFetch): the pure outbox modules (lib/rateOutboxCore.ts,
// lib/impressionAutosaveCore.ts) and their node units
// (scripts/tests/rate-outbox-units.ts, in the ROOT tsc program) import them
// from here, never from ./sessions. ./sessions re-exports them. Mirrors the
// server (lib/sessionState.ts, app/api/session/[code]/rate/route.ts): keep in
// sync.

// `aromas` (PR A, aroma-layer.md §4): {a: nodeId, m: modifierId|null} pairs
// against the @verre/core taxonomy. The node may sit at ANY tier (leaf
// "strawberry", subfamily "fruity.berry", family "fruity" — any-tier ruling
// 2026-07-08); resolve via core's getAromaNode. Optional on the wire —
// ratings written before the column shipped simply lack the key. `p` =
// pronounced flag (the note that led the impression), present only when true.
export type RatingMeta = {
  score: number;
  flavors: Record<string, number>;
  aromas?: { a: string; m: string | null; p?: boolean }[];
  // A look-in's light rating (Moment Visibility, lib/lookInCompare.ts): it has
  // aromas, which arrive with the details read. Never on a moment's own rating.
  hasAromas?: true;
  notes: string;
  at: number;
  // The rating's VERSION (rating_versions, docs/dev/rating-saves.md): on the
  // caller's OWN rows only (the server strips it from everyone else's);
  // absent = 0 (never written since the version check shipped).
  v?: number;
};
export type RatingsView = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>;

export type RateBody = {
  wineId: string;
  score?: number; // 0..5 in 0.25 steps; 0 = not rated
  // 0..5 integer intensities. Structure-wheel zero rule (§5): once ANY axis is
  // rated, the rest persist as explicit 0 ("perceived none"); if EVERY axis is
  // None the whole map is empty ({}). So a non-empty map carries zeros — do NOT
  // assume "zeros omitted" (the pre-structure-wheel contract). The server's
  // validateFlavors enforces this drop-all-or-keep-all shape.
  flavors?: Record<string, number>;
  // Aroma selections. PRESENT-REPLACES / OMITTED-PRESERVES on the server:
  // leave the field off to keep whatever is stored; send [] to clear.
  aromas?: { a: string; m: string | null; p?: boolean }[];
  notes?: string;
  // A MERGE save (the app's auto-save, docs/dev/rating-saves.md): only the
  // fields present change; at least one present; a merged EMPTY result writes
  // nothing (`unchanged`), so a merge never deletes. Without it: a full
  // replace, and an empty one reaps (the app's Clear My Rating).
  merge?: true;
  // The app's merges and Clears: the op id (a plain UUID) and the version the
  // edits are based on (0 = no version row). A stale base → 409 `stale`.
  opId?: string;
  baseVersion?: number;
  // The app's merges and Clears: the viewer the entry was made by, `u:<publicId>`
  // (the key it is stored under). The server refuses a body whose viewer isn't
  // the cookie's (409 `{ wrongViewer: true }`, nothing written).
  viewer?: string;
};

// The rate POST's answer, every outcome kept distinct (the outbox's answer
// table, lib/rateOutboxCore.ts `apply`).
export type RateResult =
  | { kind: 'rating'; status: number; rating: RatingMeta } // a committed merge: the canonical row, with `v`
  | { kind: 'unchanged'; status: number } // a merge whose merged result was empty: nothing written
  | { kind: 'ok'; status: number } // a full save (the Clear) committed
  | { kind: 'stale'; status: 409; rating: RatingMeta | null; version: number; lastOpId: string | null }
  | { kind: 'wrong-viewer'; status: 409 } // the body's viewer isn't the cookie's: nothing written
  | { kind: 'error'; status: number; retryAfterMs: number | null; auth: 'removed' | 'invalid' | null; message: string | null }
  | { kind: 'update-required' }
  | { kind: 'network'; error: unknown } // no answer: a network failure or the deadline (AMBIGUOUS)
  | { kind: 'cancelled'; reason: 'signed-out' | 'stale' | 'ineligible' }; // never sent (the outbox's gate)
