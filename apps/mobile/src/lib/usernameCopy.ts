// Pure username copy + input rules (units: scripts/tests/username-ui-units.ts).
// 🔒 No imports: the unit suite runs under the ROOT tsconfig, and anything
// that reaches react-native's types changes the global timer types there.
type Quota = { username: string | null; changesLeft: number; nextChangeAt: string | null };

export const TAKEN_TEXT = 'This username is taken.';
export const RESERVED_TEXT = 'This username is reserved.';

// What you typed, as the Username field keeps it: no `@`, ASCII lowercased
// (capitals are lowercased as typed, never reported; ruled 2026-11-14).
export function typedUsername(text: string): string {
  return text.replace(/^@+/, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// The line under Edit Profile's Username field, "quiet until it matters"
// (ruled 2026-11-14): nothing while several changes are left, a count at the
// last two, and the date once none are (`locked`: the field is read-only).
// The server names a date only when none are left, so the last two say "for now".
export function usernameQuotaLine(s: Quota, locale: string): { locked: boolean; text: string | null } {
  // A first choice is free and never counted.
  if (s.username == null || s.changesLeft > 2) return { locked: false, text: null };
  if (s.changesLeft === 2) return { locked: false, text: '2 changes left for now.' };
  if (s.changesLeft === 1) return { locked: false, text: 'This is your last change for now.' };
  return { locked: true, text: changeAgainText(s.nextChangeAt, locale) };
}

// What the profile's edit bar says about the username (the in-place edit,
// ruled 2026-11-14), while it is `active` (the field in use, changed, or the
// locked handle tapped): a `refusal` of the text typed (a broken rule, taken,
// reserved), the date once none are left, "Checking availability…" while a
// changed name waits for its answer (typing included: the line holds still
// instead of dropping back to "Editing Profile" on every keystroke),
// "Available", each with the changes left at the last two (as on Edit
// Profile), else the changes left alone. `null` = nothing to say: the bar
// keeps "Editing Profile".
export function usernameBarLine(m: {
  active: boolean; refusal: string | null; checking: boolean; available: boolean; changed: boolean; locked: boolean; quotaText: string | null;
}): { text: string; tone: 'critical' | 'positive' | 'inkSoft'; more?: string; transient?: true } | null {
  if (!m.active) return null;
  if (m.refusal) return { text: m.refusal, tone: 'critical' };
  const more = m.quotaText ? { more: m.quotaText } : {};
  // `transient`: not read out (VoiceOver would hear it at every pause in typing; the answer that follows is).
  if (!m.locked && m.changed && m.checking) return { text: 'Checking availability…', tone: 'inkSoft', ...more, transient: true };
  if (!m.locked && m.changed && m.available) return m.quotaText ? { text: 'Available.', tone: 'positive', ...more } : { text: 'Available', tone: 'positive' };
  return m.quotaText ? { text: m.quotaText, tone: 'inkSoft' } : null;
}

export function changeAgainText(nextChangeAt: string | null, locale: string): string {
  const d = nextChangeAt ? new Date(nextChangeAt) : null;
  if (!d || Number.isNaN(d.getTime())) return 'You can’t change it again yet.';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `You can change it again on ${d.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}.`;
}
