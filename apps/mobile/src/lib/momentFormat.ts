// Display formatting for moment cards/rows (02s). Presentation-only.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function liveMeta(wineCount: number, tasterCount: number | null): string {
  const parts = [plural(wineCount, 'impression')];
  if (tasterCount !== null) parts.push(plural(tasterCount, 'taster'));
  return parts.join(' · ');
}

// "Today" / "Yesterday" / "Sat 7 Jun" / "17 May 2025", per the prototype rows.
export function recentMeta(dateIso: string | null, wineCount: number): string {
  const parts: string[] = [];
  if (dateIso) {
    const day = formatDay(new Date(dateIso));
    if (day) parts.push(day);
  }
  parts.push(plural(wineCount, 'impression'));
  return parts.join(' · ');
}

function formatDay(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (!sameYear) return `${day} ${d.getFullYear()}`;
  if (diffDays < 7 && diffDays > 1) return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return day;
}
