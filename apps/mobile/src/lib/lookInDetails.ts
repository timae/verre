// The look-in's request budget (Moment Visibility step-2 plan T4, R15). The
// server's limiter is 60 a minute per viewer (`rl:lookin:u`): the first read
// every 5 s (12 a minute) plus the open Compare cards' aromas in batched
// details reads, at most one every 2 s (30 a minute): 42 at most, whatever the
// viewer opens. Pure, unit-tested from the repo root
// (scripts/tests/look-in-units.ts § 4).
//
// 🔒 The budget holds at the FETCH boundary (Codex r2): every HTTP attempt of a
// look-in (its first read, its bottle pages' reads of the same query, its
// details reads) goes through ONE gate, and the queries set `retry: false` and
// no focus / reconnect refetch, so a failing server can't double the count
// with retries and a resubscribe waits for its slot instead of bursting.

export const MAIN_GAP_MS = 5000;
export const DETAILS_GAP_MS = 2000;
export const DETAILS_REFRESH_MS = 5000;
export const DETAILS_MAX_KEYS = 10;

// One per look-in OPENING (moment + how it was opened): its screen and its
// bottle pages share it (lookInGate), so handing over from the look-in to a
// bottle page (one pauses, the other subscribes) adds no burst.
export class LookInGate {
  private lastMain = -Infinity;
  private lastDetails = -Infinity;
  constructor(private readonly clock: () => number = () => Date.now()) {}
  wait(kind: 'main' | 'details'): number {
    const last = kind === 'main' ? this.lastMain : this.lastDetails;
    return Math.max(0, last + (kind === 'main' ? MAIN_GAP_MS : DETAILS_GAP_MS) - this.clock());
  }
  // Takes the slot if it is free now; false = not yet (wait(kind) says how long).
  take(kind: 'main' | 'details'): boolean {
    if (this.wait(kind) > 0) return false;
    if (kind === 'main') this.lastMain = this.clock();
    else this.lastDetails = this.clock();
    return true;
  }
}

const gates = new Map<string, LookInGate>();
export function lookInGate(id: string): LookInGate {
  let g = gates.get(id);
  if (!g) { g = new LookInGate(); gates.set(id, g); }
  return g;
}
// Sign-out (app/_layout.tsx, beside clearLookInLinks).
export function clearLookInGates(): void {
  gates.clear();
}

// The look-in queries' policy (the first read; its bottle pages ride the same
// query): no retry, no focus / reconnect refetch, a poll every MAIN_GAP_MS.
// Every attempt still goes through the gate (throughGate), so the bound holds
// even if this changed; the units pin both.
export const LOOK_IN_QUERY_POLICY = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: MAIN_GAP_MS,
} as const;

const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Waits for the slot, then runs the attempt (the queryFn's one door). `sleep`
// is injectable for the units.
export async function throughGate<T>(
  gate: LookInGate, kind: 'main' | 'details', run: () => Promise<T>, signal?: AbortSignal,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = realSleep,
): Promise<T> {
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    if (gate.take(kind)) return run();
    await sleep(gate.wait(kind), signal);
  }
}

// One tick of the details reads (useLookInAromas runs it every 500 ms while
// focused): at most one read in flight, the batch from pickDetailsBatch, the
// slot from the gate, the keys marked loaded only on an answer (a failure
// leaves them to the next tick, which the gate spaces ≥ DETAILS_GAP_MS).
// Returns the keys it asked for, or null when it sent nothing.
export async function detailsTick(t: {
  gate: LookInGate;
  open: ReadonlyMap<string, number>;
  eligible: ReadonlySet<string>;
  loaded: Map<string, number>;
  inFlight: { current: boolean };
  now: () => number;
  fetch: (keys: string[]) => Promise<void>;
}): Promise<string[] | null> {
  if (t.inFlight.current || t.gate.wait('details') > 0) return null;
  const batch = pickDetailsBatch({ open: t.open, eligible: t.eligible, loaded: t.loaded, now: t.now() });
  if (batch.length === 0 || !t.gate.take('details')) return null;
  t.inFlight.current = true;
  try {
    await t.fetch(batch);
    const at = t.now();
    for (const k of batch) t.loaded.set(k, at);
  } catch {
    // The next tick asks again (the gate spaces it).
  } finally {
    t.inFlight.current = false;
  }
  return batch;
}

// Which open cards' aromas the next details read asks for, ≤ DETAILS_MAX_KEYS
// (a line-up has no cap, and the server refuses more than 30 keys): cards
// still without aromas first (the most recently opened first), then the
// stalest of the loaded ones once DETAILS_REFRESH_MS has passed, so every open
// card is refreshed within ceil(open / DETAILS_MAX_KEYS) reads. Only cards that
// can have aromas (`eligible`: a named person flagged `hasAromas` there; a
// card rated only by hidden people never expands, review recheck r1). [] =
// nothing due.
export function pickDetailsBatch(input: {
  open: ReadonlyMap<string, number>; // key → when it was opened
  eligible: ReadonlySet<string>;
  loaded: ReadonlyMap<string, number>; // key → when its aromas last arrived
  now: number;
}): string[] {
  const fresh: [string, number][] = [];
  const stale: [string, number][] = [];
  for (const [key, openedAt] of input.open) {
    if (!input.eligible.has(key)) continue;
    const at = input.loaded.get(key);
    if (at === undefined) fresh.push([key, openedAt]);
    else if (input.now - at >= DETAILS_REFRESH_MS) stale.push([key, at]);
  }
  fresh.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  stale.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return [...fresh, ...stale].slice(0, DETAILS_MAX_KEYS).map(([key]) => key);
}
