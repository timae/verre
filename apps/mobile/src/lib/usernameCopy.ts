// Pure username copy + input rules (units: scripts/tests/username-ui-units.ts).
// 🔒 No imports: the unit suite runs under the ROOT tsconfig, and anything
// that reaches react-native's types changes the global timer types there.
type Quota = { username: string | null; changesLeft: number; nextChangeAt: string | null };

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

export function changeAgainText(nextChangeAt: string | null, locale: string): string {
  const d = nextChangeAt ? new Date(nextChangeAt) : null;
  if (!d || Number.isNaN(d.getTime())) return 'You can’t change it again yet.';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `You can change it again on ${d.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}.`;
}
