// The bottle's pages' handoff (ruled 2026-11-22: real pages, so the bar's back
// and the edge swipe go back alike; Codex picked pages on the host's own
// stack). A FLOW is one key per invocation (never a single global slot), read
// and written by the pages through the key in their params. Two modes:
//  - 'add' (Add Impression, Check In): the search is the first screen; a pick
//    there, on a producer's wines page or a new wine's "Use" is put on the flow
//    (`setFlowChoice`) and the DETAILS screen is pushed on top, reading it. A
//    save that may have landed HOLDS its choice and id on the flow (`holdFlow`),
//    so a details screen opened again resumes them (the freeze rule).
//  - 'change' (an edit's Change): the search and the pages finish the flow with
//    a result the form takes ONCE when it is focused again.
// Pure: no React, no router (units scripts/tests/picker-flow-units.ts).
//
// 🔒 Nothing is written to the catalogue here: a picked wine or a new wine's
// draft goes back to the host form, which sends it with its own save (the
// freeze rule and the client id stay the host's).
import type { NewWineDraft } from './catalogChoice';

export type FlowProducer = { id: string; name: string; region?: string | null; country?: string | null } | { id: null; name: string };
// A wine picked on the producer's page (the host takes it as a pick, the year
// is set there), or a new wine's validated draft.
// (`yearText`: the year typed in the search, carried onto the pick.)
export type FlowResult<P> = { kind: 'product'; product: P; yearText: string } | { kind: 'new'; draft: NewWineDraft };
export type FlowMode = 'add' | 'change';

type Flow<S, T, P> = {
  scope: S;
  // Where the pages live (the host's mount and boundary), opaque to the store.
  target: T;
  mode: FlowMode;
  // 'add': where the details screen goes (opaque), the pick it opens with, and
  // a save that may have landed (its choice and id, opaque).
  dest: unknown;
  choice: FlowResult<P> | null;
  hold: unknown;
  // 'add': ONE client id for the whole flow (Codex 2026-11-22: a details screen
  // opened again mid-save took another one and could add the bottle twice).
  clientId: string | null;
  producer: FlowProducer | null;
  draft: NewWineDraft | null;
  // Pages of this flow currently mounted: what a finish pops to reach the host.
  depth: number;
  result: FlowResult<P> | null;
  done: boolean;
};

const flows = new Map<string, Flow<unknown, unknown, unknown>>();
let seq = 0;
const newKey = () => `f${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// The host opens a flow: from "Add Wine to Catalogue" (nothing seeded), or to
// edit the new wine it already holds (the draft and its producer seeded).
export function startFlow<S, T>(scope: S, target: T, seed: { draft?: NewWineDraft; mode?: FlowMode; dest?: unknown } = {}): string {
  const key = newKey();
  flows.set(key, {
    scope, target, mode: seed.mode ?? 'change', dest: seed.dest ?? null, choice: null, hold: null, clientId: null,
    producer: seed.draft?.producer ?? null, draft: seed.draft ?? null, depth: 0, result: null, done: false,
  });
  return key;
}

// 'add': the pick the details screen about to be pushed opens with.
export function setFlowChoice<P>(key: string, choice: FlowResult<P>): void {
  const f = flows.get(key);
  if (f && !f.done && f.mode === 'add') f.choice = choice;
}
// 'add': a save that may have landed holds the form as it is here (the
// choice, the fields, the photo's retry state), kept current until the form
// leaves; a details screen opened again resumes it (Codex 2026-11-22).
export function holdFlow(key: string, hold: unknown): void {
  const f = flows.get(key);
  if (f && !f.done && f.mode === 'add') f.hold = hold;
}
// 'add': the flow's one client id (made once, by `make`); `replace` after the
// server said the id is someone else's.
export function flowClientId(key: string, make: () => string, replace = false): string {
  const f = flows.get(key);
  if (!f || f.done || f.mode !== 'add') return make();
  if (f.clientId === null || replace) f.clientId = make();
  return f.clientId;
}

export function getFlow<S, T, P>(key: string | null | undefined): Readonly<Flow<S, T, P>> | null {
  const f = key ? flows.get(key) : undefined;
  return f && !f.done ? (f as Flow<S, T, P>) : null;
}

export function setFlowProducer(key: string, producer: FlowProducer): void {
  const f = flows.get(key);
  if (!f || f.done) return;
  // Another producer: a draft made under the previous one never carries over.
  if (f.producer?.id !== producer.id || f.producer?.name !== producer.name) f.draft = null;
  f.producer = producer;
}

export function setFlowDraft(key: string, draft: NewWineDraft): void {
  const f = flows.get(key);
  if (!f || f.done) return;
  f.draft = draft;
  f.producer = draft.producer;
}

// A page of the flow mounted / unmounted (a swipe back unmounts it too).
export function pageMounted(key: string): void {
  const f = flows.get(key);
  if (f && !f.done) f.depth += 1;
}
export function pageUnmounted(key: string): void {
  const f = flows.get(key);
  if (f) f.depth = Math.max(0, f.depth - 1);
}

// A page finishes the flow: the result waits for the host; the answer is how
// many pages to pop to reach it (0: the flow is gone, nothing to do).
export function finishFlow<P>(key: string, result: FlowResult<P>): number {
  const f = flows.get(key);
  if (!f || f.done) return 0;
  f.result = result;
  f.done = true;
  return f.depth;
}

// The host, focused again: the result, ONCE (and the flow is forgotten).
export function takeResult<P>(key: string | null): FlowResult<P> | null {
  if (!key) return null;
  const f = flows.get(key);
  if (!f || !f.done) return null;
  flows.delete(key);
  return f.result as FlowResult<P> | null;
}

// The host leaves (unmounts), signs out, changes scope or freezes: its flow is
// dead, and a page still open on it shows "no longer available".
export function endFlow(key: string | null): void {
  if (key) flows.delete(key);
}

// How many screens to pop to leave a flow whose first screen is `root` (the
// search): it and everything above it. `names` = the stack's route names,
// `index` = the focused one. null: the root is not on this stack (a cold link).
export function popsPast(names: readonly string[], index: number, root: string): number | null {
  for (let i = index; i >= 0; i--) if (names[i] === root) return index - i + 1;
  return null;
}

// Units only.
export const __flowsForTests = { size: () => flows.size, clear: () => flows.clear() };
