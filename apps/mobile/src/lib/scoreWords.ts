// Score + intensity vocabulary — locked in the design CLAUDE.md
// ("Scoring" section) and vero-scoring.js. Thresholds are >= boundaries.

const WORDS: Array<[number, string]> = [
  [0.25, 'Unpleasant'],
  [1, "Wouldn't do again"],
  [2, 'Alright'],
  [3, 'Good'],
  [3.75, 'Really good'],
  [4.5, 'Seek it out'],
  [5, 'Unforgettable'],
];

export function scoreWord(v: number): string {
  if (v <= 0) return 'Not rated yet';
  let w = 'Unpleasant';
  for (const [t, label] of WORDS) if (v >= t) w = label;
  return w;
}

export const INTENSITY = ['None', 'Faint', 'Light', 'Medium', 'Bold', 'Intense'] as const;

export function intensityWord(v: number): string {
  return INTENSITY[Math.max(0, Math.min(5, Math.round(v)))];
}
