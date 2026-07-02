// Display formatting for moment cards/rows (02s). Presentation-only.

import { DATE_LOCALE } from '@/lib/locale';
import type { WineTypeCode } from '@/lib/api/sessions';

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
// DATE_LOCALE keeps the words English but follows the device region's date
// order + 12/24h (see lib/locale.ts): "Jun 20 · 7:00 PM" in the US,
// "20 Jun · 19:00" elsewhere.
function startsLabel(dateFromIso: string | null): string | null {
  if (!dateFromIso) return null;
  const from = new Date(dateFromIso);
  if (Number.isNaN(from.getTime()) || from.getTime() <= Date.now()) return null;
  const now = new Date();
  const sameDay = from.toDateString() === now.toDateString();
  const label = sameDay
    ? from.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' })
    : from.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
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

// DATE_LOCALE (region-aware English — see lib/locale.ts), matching the
// home-card meta. Replaces the previously-hardcoded en-US/en-GB split.
const fmtTime = (d: Date) =>
  d.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
const fmtDayShort = (d: Date) =>
  d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });

// The ovc "when" line. Both ends carry their date AND time (no separator
// between a date and its time — just a space):
//   same day  → "Fri 20 Jun 7:00 PM – 1:00 AM"        (date once)
//   multi-day → "Fri 20 Jun 7:00 PM – Sun 22 Jun 1:00 AM"
//   no end    → "Fri 20 Jun 7:00 PM"                  (start only)
export function sessionWhen(fromIso: string | null | undefined, toIso: string | null | undefined): string | null {
  const from = fromIso ? new Date(fromIso) : null;
  if (!from || Number.isNaN(from.getTime())) return null;
  const to = toIso ? new Date(toIso) : null;
  const day = formatDay(from) ?? fmtDayShort(from);
  if (to && !Number.isNaN(to.getTime())) {
    const sameDay = from.toDateString() === to.toDateString();
    // Same day: the date once (relative "Today"/"Yesterday" is fine — one
    // date, no asymmetry), then the time range.
    if (sameDay) return `${day} ${fmtTime(from)} – ${fmtTime(to)}`;
    // Multi-day: full date + time on BOTH ends — and the start uses the
    // ABSOLUTE date (fmtDayShort), not `day`. A relative "Today" start against
    // an absolute end ("Today 7:00 PM – Sun 22 Jun 1:00 AM") reads lopsided;
    // both ends absolute keeps the range symmetric.
    return `${fmtDayShort(from)} ${fmtTime(from)} – ${fmtDayShort(to)} ${fmtTime(to)}`;
  }
  return `${day} ${fmtTime(from)}`;
}

function formatDay(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  // DATE_LOCALE so day/month order follows the viewer's locale (20 Jun vs Jun 20).
  const day = d.toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' });
  if (!sameYear) return `${day} ${d.getFullYear()}`;
  if (diffDays < 7 && diffDays > 1) return d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  return day;
}

// Wine type codes ↔ display labels — the web AddWineModal's exact list (labels
// like "Sparkling"; the server stores the code). Used by the add-impression
// Type dropdown. (Compare shows producer-only rows — Simon's ruling.)
export const WINE_TYPES: Array<{ code: WineTypeCode; label: string }> = [
  { code: 'red', label: 'Red' },
  { code: 'white', label: 'White' },
  { code: 'spark', label: 'Sparkling' },
  { code: 'rose', label: 'Rosé' },
  { code: 'nonalc', label: 'Non-alc' },
];
