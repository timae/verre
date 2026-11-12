import { Share } from 'react-native';
import { WEB_BASE } from '@/lib/config';

// A profile's link (D6): the website, for the share sheet AND the QR (the
// iPhone Camera opens it in the browser; an in-app scan reads it back,
// lib/scanCode.ts). A logged-out visitor sees what that account shows.
export function profileLink(id: number): string {
  return `${WEB_BASE}/u/${id}`;
}

// The OS share sheet with someone's profile link ("Lena on Verre"; the link
// alone when the name isn't known, e.g. your own profile offline).
export async function shareProfile(name: string, id: number): Promise<void> {
  const url = profileLink(id);
  try {
    await Share.share(name.trim() ? { message: `${name.trim()} on Verre`, url } : { url, message: url });
  } catch {
    // Share.share rejects only on an error (a dismissal resolves); nothing to recover.
  }
}
