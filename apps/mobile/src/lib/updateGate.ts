import { router } from 'expo-router';

export interface UpdateRequiredBody {
  minVersion?: string;
  storeUrl?: string;
}

// ── The 426 update-required gate ───────────────────────────────────────────
//
// A 426 can arrive from the very first get-session round-trip, which happens
// BEFORE the root navigator exists. So the body is buffered and flushed once
// navigation is ready.
//
// 🔒 READINESS IS AN EXPLICIT STATE, NOT AN EXCEPTION. The previous version
// called `router.replace` inside a try/catch and treated a throw as "not ready
// yet". That is unreliable: expo-router QUEUES a replace rather than throwing,
// and its queue can silently discard the action when no navigation ref exists.
// Worse, the old `replaceNow` cleared `pending` BEFORE navigating — so a
// silently-dropped replace lost the 426 permanently, with nothing thrown to
// catch and nothing left to retry. A blocking update screen that never appears
// is a client that keeps talking to an incompatible server.
//
// The contract:
//   • Before readiness  — store the body, navigate NOTHING.
//   • markUpdateNavigationReady() — flush exactly one pending body, then latch.
//   • After readiness   — route immediately.
//   • `pending` is cleared ONLY on the known-ready dispatch path.
//   • Repeated pre-ready 426s: LATEST BODY WINS (it reflects the server's
//     current requirement; an older minVersion is strictly staler).
//   • Repeated readiness calls never navigate twice.

let pending: UpdateRequiredBody | null = null;
let navigationReady = false;

// Seam for tests — production never swaps this, so it always routes through
// expo-router.
type Replace = (body: UpdateRequiredBody) => void;
const defaultReplace: Replace = (body) => {
  router.replace({
    pathname: '/update-required',
    params: { minVersion: body.minVersion ?? '', storeUrl: body.storeUrl ?? '' },
  });
};
let replaceImpl: Replace = defaultReplace;

export function routeToUpdateRequired(body: UpdateRequiredBody | null) {
  const next = body ?? {};
  if (!navigationReady) {
    // Latest wins: a newer 426 carries the server's current requirement.
    pending = next;
    return;
  }
  replaceImpl(next);
}

// Called from the root navigator AFTER the resolved-session Stack has
// committed. 🔒 The splash deadline must NOT call this — at that point neither
// route group is mounted, so there is no navigator to replace into.
export function markUpdateNavigationReady() {
  if (navigationReady) return; // idempotent: never navigate twice
  navigationReady = true;
  if (!pending) return;
  const body = pending;
  pending = null; // cleared only here, on the known-ready path
  replaceImpl(body);
}

// ── Test seam ──────────────────────────────────────────────────────────────
// Not called by application code.
export function __resetUpdateGate(replace?: Replace) {
  pending = null;
  navigationReady = false;
  replaceImpl = replace ?? defaultReplace;
}
export function __updateGateState() {
  return { pending, navigationReady };
}
