import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { authClient } from './authClient';
import { bootGate, type StaleCookie, UNREADABLE_COOKIE } from './bootGate';
import { secureStorage } from './secureStorage';

// 🔒 iOS reinstall wipe (proposal 06 §2, ruled 2026-11-04).
//
// @better-auth/expo keeps the native session in the Keychain (secureStorage.ts)
// and iOS keeps Keychain items when the app is deleted, while native sessions
// are a 1-year sliding window — so a phone handed on without a factory reset
// would sign the next owner in as the previous one. The marker below lives in
// AsyncStorage, i.e. inside the app container (iOS: Library/Application
// Support/<bundleId>/, which deletion removes; Android: app-private SQLite,
// likewise removed), so "marker absent" means "this install never ran": the
// Keychain items are leftovers from a previous install and get cleared.
//
// 🔒 ORDERING. The Expo client seeds its session atom from `verre_session_data`
// synchronously inside createAuthClient (module init of authClient.ts), and
// that seed's `sessionAtom.get()` already fires the first get-session
// heartbeat (nanostores mounts a store on `get()`). This step therefore runs
// from the root layout AFTER module init (an async marker read cannot precede
// a synchronous seed) but BEFORE RootNavigator (the first `useSession`
// subscriber) mounts — it resets the seeded atom itself, and lib/bootGate.ts
// holds every Better Auth request built before the verdict so no response
// from the old cookie can land after the wipe. Never move it below
// RootNavigator, never subscribe to the session above the guard, and never
// call `atom.get()` here (`.value` reads without mounting the query).
//
// 🔒 FAILURE POSTURE. Every Keychain read sits inside one error boundary and
// the atom is reset before the first of them, so a throwing read can neither
// strand the gate nor leave the previous owner renderable. A wipe counts as
// successful only when every target key READS BACK as gone or overwritten —
// iOS SecureStore discards the SecItemDelete status, so a resolved delete
// proves nothing. Otherwise no marker is written (retry next launch) and the
// gate strips the stale cookie from every request meanwhile.
//
// Costs (accepted): a genuine reinstall by the owner signs in again, and the
// first launch of a build that introduces the marker signs an existing install
// out once (no marker yet, so it looks like a reinstall). An Offload-and-
// reinstall keeps documents & data, so the marker survives it.
const MARKER_KEY = 'verre.installed';
// The `storagePrefix: 'verre'` items of @better-auth/expo (authClient.ts).
const BA_KEYS = ['verre_cookie', 'verre_session_data'] as const;
// Values over 1800 chars are split into `<key>.<i>` chunks (@better-auth/expo
// storageAdapter, base value `\u0001ba-chunks:<n>`). ⚠️ The adapter's
// short-value branch (an ordinary sign-out's "{}" included) overwrites the
// base key WITHOUT deleting earlier chunks, so orphan chunks holding an old
// session are normal — discovery probes the chunk keys themselves, never the
// marker. And it scans EVERY slot: the SDK writes a contiguous 0..n-1 run, but
// a partially failed wipe (one chunk the Keychain refused) leaves a sparse one,
// and the retry must still find the chunk behind the gap. 64 slots × 1800
// chars is far beyond any session payload.
const CHUNK_SLOTS = 64;
// Best-effort server revoke. The request is ABORTED at the deadline, not left
// running: a late sign-out response would apply its cookie-expiry header to
// whatever cookie a subsequent sign-in had stored.
const SIGN_OUT_WAIT_MS = 3000;
// What the SDK's own sign-out leaves behind; also what a refused delete is
// overwritten with. Neither parses to a cookie nor seeds the cache.
const EMPTY = '{}';

async function readMarker(): Promise<string | null> {
  // An unreadable marker is treated as absent (fail closed): the cost is one
  // extra sign-in, the alternative is a leaked account.
  try { return await AsyncStorage.getItem(MARKER_KEY); } catch { return null; }
}

function targetKeys(): string[] {
  return BA_KEYS.flatMap((key) => [
    key,
    ...Array.from({ length: CHUNK_SLOTS }, (_, i) => `${key}.${i}`).filter((k) => secureStorage.getItem(k) != null),
  ]);
}

// Pristine no-cache state (isPending: true): the root layout holds the splash
// until the heartbeat answers, exactly like a first install. Reads `.value`,
// not `.get()` — a get() on an unmounted store mounts it and fires a fetch.
function resetSessionAtom(): void {
  const session = authClient.$store.atoms.session;
  session?.set({ ...session.value, data: null, error: null, isPending: true, isRefetching: false });
}

async function revokeServerSession(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_OUT_WAIT_MS);
  // The Expo client's init hook reads the cookie into this request, then clears
  // both items and resets the atom BEFORE the request leaves, so the local
  // effect is immediate even offline. Awaited to settlement: after the abort
  // nothing of it is still running.
  try { await authClient.signOut({ fetchOptions: { signal: controller.signal } }); } catch { /* best-effort */ }
  finally { clearTimeout(timer); }
}

// Every delete is awaited to settlement (a still-pending delete could remove a
// LATER sign-in's cookie), then every key is read back: gone, or overwritten
// with EMPTY when the Keychain kept it. Returns false if any key still holds
// its contents; throws if the Keychain cannot be read.
async function clearKeys(keys: string[]): Promise<boolean> {
  const results = await Promise.allSettled(keys.map((k) => secureStorage.deleteItem(k)));
  let cleared = true;
  keys.forEach((key, i) => {
    if (results[i].status === 'rejected') console.warn('[freshInstall] Keychain delete refused', key);
    if (secureStorage.getItem(key) == null) return;
    try { secureStorage.setItem(key, EMPTY); } catch { /* verified below */ }
    const left = secureStorage.getItem(key);
    if (left != null && left !== EMPTY) cleared = false;
  });
  return cleared;
}

async function clearLeftovers(): Promise<{ cleared: boolean; stale: string | null }> {
  const keys = targetKeys();
  if (keys.every((k) => secureStorage.getItem(k) == null)) return { cleared: true, stale: null };
  const snapshot = secureStorage.getItem('verre_cookie');
  bootGate.beginWipe();
  // Gated on a live cookie: without one there is no server session to revoke
  // and the POST would only cost a fresh install a request.
  if (authClient.getCookie()) await revokeServerSession();
  let cleared = false;
  try { cleared = await clearKeys(keys); }
  finally { resetSessionAtom(); } // signOut's own reset leaves isPending false — restore pristine on every path
  return { cleared, stale: cleared ? null : snapshot };
}

let pending: Promise<void> | null = null;

export function ensureFreshInstallWiped(): Promise<void> {
  pending ??= (async () => {
    let marker: string | null = null;
    let stale: StaleCookie = null;
    try {
      marker = await readMarker();
      if (marker) return;
      // In memory first, before the first Keychain read: nothing below can
      // fail in a way that leaves the previous owner renderable.
      resetSessionAtom();
      const outcome = await clearLeftovers();
      stale = outcome.stale;
      // Written only after a verified wipe: anything less retries next launch.
      if (outcome.cleared) await AsyncStorage.setItem(MARKER_KEY, new Date().toISOString());
      else console.warn('[freshInstall] Keychain kept the old session; its cookie is stripped from requests, retry next launch');
    } catch (e) {
      stale = UNREADABLE_COOKIE;
      console.warn('[freshInstall] wipe failed; no cookie is sent this launch, retry next launch', e);
    } finally {
      // 🔒 Always settles, or every Better Auth request would hang forever.
      bootGate.settle(marker ? 'kept' : 'wiped', stale);
    }
  })();
  return pending;
}

// Root-layout gate: true once the check has run (success or not — boot never
// blocks on it beyond the bounded sign-out wait).
export function useFreshInstallGuard(): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    let live = true;
    ensureFreshInstallWiped().finally(() => { if (live) setDone(true); });
    return () => { live = false; };
  }, []);
  return done;
}
