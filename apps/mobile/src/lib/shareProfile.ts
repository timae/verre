import { Share } from 'react-native';
import { profilePath } from '@verre/core';
import { WEB_BASE } from '@/lib/config';

// A profile's link (D6): the website, for the share sheet AND the QR (the
// iPhone Camera opens it in the browser; an in-app scan reads it back,
// lib/scanCode.ts). A logged-out visitor sees what that account shows.
// `id` is the PUBLIC id (public-user-ids): the link names nothing the
// integer user id would give away. Lowercase, like every profile link (profilePath).
export function profileLink(id: string): string {
  return `${WEB_BASE}${profilePath(id)}`;
}

// The OS share sheet with someone's profile link ("Lena on Verre"; the link
// alone when the name isn't known, e.g. your own profile offline).
export async function shareProfile(name: string, id: string): Promise<void> {
  const url = profileLink(id);
  try {
    await Share.share(name.trim() ? { message: `${name.trim()} on Verre`, url } : { url, message: url });
  } catch {
    // Share.share rejects only on an error (a dismissal resolves); nothing to recover.
  }
}
