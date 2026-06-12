import { router } from 'expo-router';

export interface UpdateRequiredBody {
  minVersion?: string;
  storeUrl?: string;
}

// Imperative navigation THROWS before the root layout mounts (expo-router
// assertIsReady) — and the very first get-session round-trip is exactly that
// window. So a 426 is buffered here; the root navigator consumes it right
// after mount. Post-mount 426s route immediately.
let pending: UpdateRequiredBody | null = null;

export function routeToUpdateRequired(body: UpdateRequiredBody | null) {
  pending = body ?? {};
  try {
    replaceNow();
  } catch {
    // Root layout not mounted yet — consumePendingUpdateRequired routes it.
  }
}

export function consumePendingUpdateRequired() {
  if (!pending) return;
  try {
    replaceNow();
  } catch {
    return; // keep it pending; the next 426 (session refetch) retries anyway
  }
}

function replaceNow() {
  const body = pending;
  pending = null;
  router.replace({
    pathname: '/update-required',
    params: { minVersion: body?.minVersion ?? '', storeUrl: body?.storeUrl ?? '' },
  });
}
