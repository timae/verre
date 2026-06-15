// Display formatting for moment cards/rows (02s). Presentation-only.

// "Hosted by X". Pass null to omit (e.g. when the host name already serves as
// the card title on a name-less moment) so it isn't repeated.
const hostedBy = (hostName: string) => `Hosted by ${hostName}`;

// Carousel-card meta line. A still-future moment leads with "Starts …" (the
// date, or just the time when it starts today), then "Hosted by …". A
// live/started or date-less card shows "Hosted by …" alone. `hostName` is
// already resolved by the caller ("you" for the viewer-host, null to omit when
// the host name is the card title).
export function liveMeta(dateFromIso: string | null, hostName: string | null): string {
  const parts: string[] = [];
  const starts = startsLabel(dateFromIso);
  if (starts) parts.push(starts);
  if (hostName) parts.push(hostedBy(hostName));
  return parts.join(' · ');
}

// "Starts 13:00" when date_from is today, "Starts Sat 7 Jun" otherwise.
// Null unless date_from is in the future (a started/past date isn't a "Starts").
// Locale-less (undefined) so time + date render in the VIEWER's own locale and
// 12/24h preference — a European device shows 13:00, a US one 1:00 PM.
function startsLabel(dateFromIso: string | null): string | null {
  if (!dateFromIso) return null;
  const from = new Date(dateFromIso);
  if (Number.isNaN(from.getTime()) || from.getTime() <= Date.now()) return null;
  const now = new Date();
  const sameDay = from.toDateString() === now.toDateString();
  const label = sameDay
    ? from.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : from.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `Starts ${label}`;
}

// "Today" / "Yesterday" / "Sat 7 Jun" / "17 May 2025", per the prototype rows.
export function recentMeta(dateIso: string | null, hostName: string | null): string {
  const parts: string[] = [];
  if (dateIso) {
    const day = formatDay(new Date(dateIso));
    if (day) parts.push(day);
  }
  if (hostName) parts.push(hostedBy(hostName));
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
