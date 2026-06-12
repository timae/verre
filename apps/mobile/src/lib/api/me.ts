import { apiFetch } from '../apiFetch';

export type MyAccount = { name: string | null; email: string | null; pro: boolean };

// Minimal self profile — `pro` gates pro-only affordances in the UI (02a
// blind toggle renders disabled + PRO badge for non-pro; the server 403 is
// the backstop, never the only gate the user sees).
export async function getMyAccount(): Promise<MyAccount> {
  const res = await apiFetch('/api/me/account');
  if (!res.ok) throw new Error(`account fetch failed (${res.status})`);
  return res.json();
}
