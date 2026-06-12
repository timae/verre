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

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDayShort = (d: Date) =>
  d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// The ovc "when" line: "Fri 20 Jun · 7:00 PM – 1:00 AM" single-day,
// "Fri 20 Jun – Sun 22 Jun · from 7:00 PM" multi-day.
export function sessionWhen(fromIso: string | null | undefined, toIso: string | null | undefined): string | null {
  const from = fromIso ? new Date(fromIso) : null;
  if (!from || Number.isNaN(from.getTime())) return null;
  const to = toIso ? new Date(toIso) : null;
  const day = formatDay(from) ?? fmtDayShort(from);
  if (to && !Number.isNaN(to.getTime())) {
    const sameDay = from.toDateString() === to.toDateString();
    if (sameDay) return `${day} · ${fmtTime(from)} – ${fmtTime(to)}`;
    return `${fmtDayShort(from)} – ${fmtDayShort(to)} · from ${fmtTime(from)}`;
  }
  return `${day} · ${fmtTime(from)}`;
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
