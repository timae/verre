// The bottle picker's search state, as a pure transition controller (step 7b,
// ADR-0010; units scripts/tests/bottle-search-units.ts, the app sim drives it
// against the real HTTP route). BottlePicker holds one per search field (the
// one field, "Add Wine to Catalogue"'s producer field, its wine field) and only renders
// what this says.
//
// 🔒 A MONOTONIC REQUEST GENERATION identifies the current request, never the
// text (Codex r2 P2: with A → B → A an old A's answer could land after the new
// A failed). Every new text, scope change, reset and pick moves it on; an
// answer or a failure for any other generation is dropped.
// 🔒 "Add Wine to Catalogue" (and "Add Producer") is offered only after a
// SUCCESSFUL answer for the CURRENT generation (review r1 P2: offered during a
// 429, a failure or a debounce, a person created a duplicate of a wine the
// search never looked for), and never on a refused (`tooLong`) one. Stale rows
// are never selectable.

export type SearchFailure = 'off' | 'busy' | 'failed';
export type SearchAnswer<T> = { results: T[]; more: boolean; tooLong: boolean; exact?: boolean };

export type SearchState<T> = {
  text: string;
  gen: number;
  // idle: nothing to search (under the minimum); waiting: the debounce or the
  // request is in flight; answered: `results` are the current generation's.
  status: 'idle' | 'waiting' | 'answered' | 'failed';
  results: T[];
  resultsGen: number; // the generation `results` belong to (-1: none)
  more: boolean;
  tooLong: boolean;
  exact: boolean; // the server: a listed producer carries exactly the typed name
  failure: SearchFailure | null;
  // The shortest text that is searched: 3 for the every-word searches (the
  // server's minimum), 0 for a chosen producer's wines (it lists them A to Z).
  min: number;
};

export const MIN_QUERY = 3;

export function initialSearch<T>(min = MIN_QUERY): SearchState<T> {
  return { text: '', gen: 0, status: 'idle', results: [], resultsGen: -1, more: false, tooLong: false, exact: false, failure: null, min };
}

export type SearchEvent<T> =
  | { type: 'text'; text: string } // a keystroke (or the field set by code)
  | { type: 'reset' } // a scope change, a pick, leaving the step
  | { type: 'answer'; gen: number; answer: SearchAnswer<T> }
  | { type: 'fail'; gen: number; failure: SearchFailure };

export function searchReducer<T>(s: SearchState<T>, e: SearchEvent<T>): SearchState<T> {
  switch (e.type) {
    case 'text': {
      const gen = s.gen + 1;
      // The rows stay on screen while the next answer is awaited (no flicker),
      // but they are no longer the current generation's: not selectable.
      if (e.text.trim().length < s.min) return { ...s, text: e.text, gen, status: 'idle', results: [], resultsGen: -1, more: false, tooLong: false, exact: false, failure: null };
      return { ...s, text: e.text, gen, status: 'waiting', more: false, tooLong: false, exact: false, failure: null };
    }
    case 'reset':
      return { ...initialSearch<T>(s.min), gen: s.gen + 1 };
    case 'answer':
      if (e.gen !== s.gen || s.status !== 'waiting') return s;
      return { ...s, status: 'answered', results: e.answer.results, resultsGen: e.gen, more: e.answer.more, tooLong: e.answer.tooLong, exact: !!e.answer.exact, failure: null };
    case 'fail':
      if (e.gen !== s.gen || s.status !== 'waiting') return s;
      // The rows of an older answer are not this text's: gone, not just inert.
      return { ...s, status: 'failed', results: [], resultsGen: -1, more: false, tooLong: false, exact: false, failure: e.failure };
  }
}

// What to send now (after the debounce): the text and the generation it is
// for, or nothing.
export function pendingRequest<T>(s: SearchState<T>): { gen: number; q: string } | null {
  return s.status === 'waiting' ? { gen: s.gen, q: s.text.trim() } : null;
}

// The rows to show, and whether a tap may pick one.
export function visibleRows<T>(s: SearchState<T>): { rows: T[]; selectable: boolean } {
  return { rows: s.results, selectable: s.status === 'answered' && s.resultsGen === s.gen };
}

// "Add Wine to Catalogue" (or "Add Wine “…”" in a producer's list): only after
// a successful, non-refused answer for exactly this generation.
export function offersNew<T>(s: SearchState<T>): boolean {
  return s.status === 'answered' && s.resultsGen === s.gen && !s.tooLong;
}

// "Add Producer “…”" (ruled 2026-11-21): when the search found nothing, or when
// none of the producers it found carries exactly the typed name (a new "Marx"
// must stay addable while "Weingut Marx" exists). Never while a listed producer
// IS the typed name: pick it instead. "Exactly" is the SERVER's verdict
// (`exact`, folded by the database: "Strass" = "Straß", Codex 2026-11-21).
export function offersAddProducer<T>(s: SearchState<T>): boolean {
  return offersNew(s) && !!s.text.trim() && !s.exact;
}

// The quiet line under the field: why the list is what it is. `noun`: what the
// field lists ("wines", "producers").
export function searchNotice<T>(s: SearchState<T>, noun = 'wines'): string | null {
  if (s.status === 'failed') {
    return s.failure === 'off' ? 'Adding bottles is unavailable right now.' : s.failure === 'busy' ? 'Too many searches. Wait a moment.' : 'Search failed. Try again.';
  }
  if (s.status !== 'answered' || s.resultsGen !== s.gen) return null;
  if (s.tooLong) return 'Too many words. Try a shorter search.';
  if (s.more) return `More ${noun} match. Type more to narrow the list.`;
  return null;
}

// A tap on a one-field row: the wine, and the year to put in the year field
// (the carried one, else nothing). null = the tap is not allowed (a stale row).
export function pickRow<T extends { id: string; year: number | null }>(s: SearchState<T>, id: string): { hit: T; yearText: string } | null {
  if (!visibleRows(s).selectable) return null;
  const hit = s.results.find((r) => r.id === id);
  return hit ? { hit, yearText: hit.year === null ? '' : String(hit.year) } : null;
}
