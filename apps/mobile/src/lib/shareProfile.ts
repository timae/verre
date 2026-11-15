import { Share } from 'react-native';
import { profilePath, profileSharePath } from '@verre/core';
import { WEB_BASE } from '@/lib/config';

// A profile's QR link (D6): the website, by PUBLIC id (public-user-ids): the
// link names nothing the integer user id would give away, and it survives a
// rename, which is why the QR keeps it (usernames § 11). The iPhone Camera
// opens it in the browser; an in-app scan reads it back (lib/scanCode.ts).
// Lowercase, like every profile link (profilePath).
export function profileLink(id: string): string {
  return `${WEB_BASE}${profilePath(id)}`;
}

// The link people SHARE and read: `/@name`, or the id link while someone has
// no username. A logged-out visitor sees what that account shows.
export function profileShareLink(person: { id: string; username?: string | null }): string {
  return `${WEB_BASE}${profileSharePath(person)}`;
}

// The same link as it is SHOWN (the share card): no scheme.
export function profileShareLabel(person: { id: string; username?: string | null }): string {
  return profileShareLink(person).replace(/^https?:\/\//, '');
}

// The OS share sheet with someone's profile link ("Lena on Verre"; the link
// alone when the name isn't known, e.g. your own profile offline).
export async function shareProfile(name: string, person: { id: string; username?: string | null }): Promise<void> {
  const url = profileShareLink(person);
  try {
    await Share.share(name.trim() ? { message: `${name.trim()} on Verre`, url } : { url, message: url });
  } catch {
    // Share.share rejects only on an error (a dismissal resolves); nothing to recover.
  }
}
