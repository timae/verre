import { isPublicUserId } from '@verre/core';
import { authClient } from '@/lib/authClient';

// Your own user id: the PUBLIC id from Better Auth's session (the server's
// route wrapper rewrites `user.id`; public-user-ids § 5). An opaque string,
// never parsed. null while signed out, and for a cached session written
// before the switch (an integer: `_layout.tsx` treats that as not yet known,
// so the signed-in screens never mount on it).
export function meIdOf(session: { user?: { id?: unknown } } | null | undefined): string | null {
  const id = session?.user?.id;
  return isPublicUserId(id) ? id : null;
}

export function useMeId(): string | null {
  return meIdOf(authClient.useSession().data);
}
