// Forgiving search — shared by EVERY search field in the app (Simon's ruling
// 2026-07-03): diacritic-insensitive ("venenum" finds "Vénénum") and small
// typos excused. Route any new search filter through fuzzyIncludes; don't
// hand-roll .toLowerCase().includes() matching.
//
// Matching model: every whitespace-separated query token must hit the
// haystack — as a plain substring, or fuzzily against a haystack word or
// word-prefix (so mid-typing typos still match). Typo budget scales with
// token length: <4 chars exact only (a 3-char token with an edit is a
// different word), 4–6 chars 1 edit, ≥7 chars 2 edits. Distance is OSA
// (Levenshtein + adjacent transposition counts as ONE edit — "Vénénmu").

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd' };

// Lowercase, strip combining marks (NFD), fold the letters NFD can't decompose.
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßæœøđłþð]/g, (ch) => FOLD[ch]!);
}

// OSA distance ≤ max, with an early exit when a whole row exceeds the budget.
// Inputs are single words, so the O(len²) DP is nothing.
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prevPrev: number[] | null = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

function tokenHits(hay: string, hayWords: string[], tok: string): boolean {
  if (hay.includes(tok)) return true;
  // Digit tokens match exactly — a year query must not fuzz into the
  // neighbouring vintages ("2023" ⇏ 2022/2024; Simon 2026-07-03).
  if (/^\d+$/.test(tok)) return false;
  const tol = tok.length >= 7 ? 2 : tok.length >= 4 ? 1 : 0;
  if (tol === 0) return false;
  return hayWords.some((w) => {
    if (withinDistance(w, tok, tol)) return true;
    // Prefix-fuzzy: the token is a typo'd PREFIX of a longer word. Window the
    // prefix length by ±tol so a dropped/doubled letter mid-token still lands
    // ("vennum" ⇢ "venenum" via the length-7 prefix).
    for (let L = tok.length - tol; L <= tok.length + tol; L++) {
      if (L <= 0 || L >= w.length) continue;
      if (withinDistance(w.slice(0, L), tok, tol)) return true;
    }
    return false;
  });
}

export function fuzzyIncludes(hay: string, query: string): boolean {
  const q = normalizeSearch(query).trim();
  if (!q) return true;
  const h = normalizeSearch(hay);
  const words = h.split(/[^a-z0-9]+/).filter(Boolean);
  return q.split(/\s+/).every((tok) => tokenHits(h, words, tok));
}
