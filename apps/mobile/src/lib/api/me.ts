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

export type Friend = { id: number; name: string };

// Mutual follows (you follow each other), block-pair members already dropped
// server-side. Used by the invite sheet's friend chips / browse list. The
// identity id for matching against session participants is `u:${id}`.
export async function getMyFriends(): Promise<Friend[]> {
  const res = await apiFetch('/api/me/friends');
  if (!res.ok) throw new Error(`friends fetch failed (${res.status})`);
  return res.json();
}
