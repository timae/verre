# 00 — Shared-logic extraction

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). **This is the one workstream every reviewer flagged as the safe first move** — zero security surface, immediate web benefit, and it keeps the topology decision ([O1](README.md#3-deferred-decisions-deliberately-open)) open instead of foreclosing it.

## 1. The problem

Today, validation and domain rules that are genuinely framework-neutral live in `lib/`, imported by both server route handlers and client components from one Next.js repo. The moment a *second* client exists (the Expo app), each of these rules is at a fork:

- **Import it** from a shared location → one source of truth, no drift.
- **Re-implement / copy it** into the RN app → two copies that silently diverge.

The danger is not theoretical. Several of these rules are **cross-cutting invariants** that are subtle and have a *silent* failure mode if a second implementation gets them slightly wrong. The canonical trap is the score wire-format: Prisma's `Decimal` serializes to a JSON **string** (`"4.25"`), and every response must coerce via `Number()` (root CLAUDE.md, Score system). A second client that forgets this ships string-where-number and arithmetic breaks quietly. Re-deriving score validation, the Crockford code rules, or that coercion in a fresh codebase, by someone who didn't write the first, is how you get two subtly-different definitions of "valid."

## 2. The fix in one paragraph

Extract the framework-neutral logic into a **shared package** (a workspace package, e.g. `packages/core`) that both the Next.js API and the Expo app depend on. Nothing about the *behaviour* changes; this is a move + a dependency edge. Do it **before** the RN app exists, so the RN app is born importing the shared package rather than copying from `lib/`.

## 3. What is genuinely shareable (verified)

These are pure, no-DOM, no-Node, no-Next, no-Prisma-client logic. They can move as-is:

| Source today | What it is | Shareable? |
|---|---|---|
| `lib/sessionCode.ts` (`normalizeCode`, `validateCodeInput`, `formatCode`, `formatCodeInput`, `ALPHABET`, `VALID_LENGTHS`) | Crockford session-code alphabet + normalization + validation | ✅ pure |
| `lib/checkinValidation.ts` `validateScore` | The 0..5-in-0.25-steps score validation | ✅ pure — relocate **unchanged** (see §4) |
| `lib/formatScore.ts` | Score → display string | ✅ pure |
| `lib/displayName.ts` (`validateDisplayName`, `stripDisambiguationEmoji`) | Client-safe display-name rules | ✅ pure (the `.server` half stays server-only — it imports Redis) |
| `lib/decimal.ts` `decimalToNumber` | The Decimal→number coercion (already a named helper, 19 sites) | ⚠️ relocate carefully — see §4 (type-only Prisma import) |
| Wire types (`WireWine`, rating/identity shapes) | The request/response contracts | ✅ should be shared types |

**Carve-outs — do NOT blindly move the whole file:**
- `lib/sessionCode.ts` also exports `sessionPath()` / `joinPath()` (**web URL paths** — RN navigation doesn't use them the same way) **and `genCode()`** (mints a code via `import crypto from 'crypto'` — a Node built-in Metro rejects, and the RN app never mints codes anyway). Keep both server-side; only the pure list above moves.
- `lib/displayName.server.ts` stays server-only (Redis import). Only the client-safe `displayName.ts` half moves.

## 4. Score validation + coercion: relocate, don't "unify" (reviewer correction)

An earlier draft of this doc claimed there were *two divergent* score-validation copies and that the extraction should "unify" them. **That was wrong** (caught in review). There is exactly **one** server-side validator — `validateScore` in `lib/checkinValidation.ts` — imported by all three write boundaries (`rate`, `checkins` POST, `checkins/[id]`). The client widgets only *snap* input to 0.25 steps; they don't validate-and-reject, so they are not a second copy.

So the move is **purely mechanical: relocate `validateScore` into `packages/core` unchanged.** Do NOT "reconcile" it to the bare predicate `v >= 0 && v <= 5 && Number.isInteger(v*4)` — `validateScore` carries behavior the bare predicate lacks (returns `{value: null}` for the "not rated" null/undefined path, and the `{value}` vs `{error}` return shape the three callers depend on). Swapping in the predicate would regress null-handling and the return contract.

Same discipline for coercion: the Decimal→number coercion is **already** a named helper, `decimalToNumber` in `lib/decimal.ts` (~19 references across 8 files — call sites in 7 files + the definition; note a couple coerce `feed_item` geo `lat`/`lng` Decimals, not scores — the helper is field-agnostic, so they relocate fine too) — do NOT invent a new `coerceScore()` that would become a second, drifting helper. Relocate `decimalToNumber` under its existing name. One wrinkle (§5 mandates "no `@prisma/client` in core"): `decimal.ts` does `import type { Prisma }` for the `Prisma.Decimal` input type. Because it's a **type-only** import it *erases* at compile and pulls no runtime client into the Metro bundle — but to be safe, redefine the input as a structural `{ toString(): string } | number | null` in core so it needs zero Prisma reference, and migrate all sites in the same change.

## 5. Tooling reality (not glossed)

A shared package consumed by **two different bundlers** — Next (webpack/turbopack) and Expo (Metro) — will surface bundler-disagreement pain. The codebase already has warning signs of this class of issue:

- The Next 15 + webpack bundling bug forcing inlined S3 copies (`lib/CLAUDE.md`, `app/api/session/[code]/route.ts` notes "until fixed upstream").
- The Edge-bundling instrumentation foot-gun (`app/CLAUDE.md` — a `NEXT_RUNTIME` guard doesn't stop webpack *bundling* a `node:*` import for Edge).

**Implications for `packages/core`:**
- It must be **dependency-light and platform-pure** — no `node:*`, no `next/*`, no `@prisma/client`, no React, no DOM. If a thing needs any of those, it doesn't belong in core. Metro is stricter than webpack about Node built-ins, so "pure" is enforced by the harder of the two bundlers.
- Ship it as plain TypeScript source consumed via workspace path (simplest) rather than a pre-built dist, unless a bundler disagreement forces a build step. Decide per real failure, not preemptively.
- This is **manageable, not free.** Budget for a round of "Metro doesn't like X that webpack tolerated."

**As built (shipped) + the Metro follow-up this defers:** `packages/core` ships as plain TS source — `package.json` sets `"type": "module"` and points `main`/`types`/`exports` directly at `./src/index.ts` (no build step), consumed via the npm workspace symlink. This resolves cleanly today for **tsc + Next/webpack** (verified: `tsc --noEmit` + `npm run build` green, and the standalone build inlines core into the server chunks). **It is NOT yet proven against Metro, and the entry-point shape is the specific thing Metro is least likely to accept as-is:** Metro does not transform `.ts` files in `node_modules`/workspace packages by default. When the RN/Expo app first imports `@verre/core`, expect to need a `metro.config.js` with `resolver.sourceExts` including `ts`/`tsx` + `watchFolders` covering the monorepo root (and possibly `unstable_enablePackageExports`) — OR to add a `dist` build step for core and repoint `exports` (which would then make the redundant-alias divergence from the earlier review relevant again). This is the "decide per real failure" call from above, now scoped: **owner = the RN topology workstream ([03](03-topology.md)); do not pre-build core until Metro actually rejects the source entry.** Barrel re-exports are extensionless (`from './sessionCode'`), fine under `moduleResolution: bundler` but would also need attention under a raw-Node-ESM consumer (none exists today).

## 6. Why this is first and safe

- **No security surface.** Moving pure validation functions can't introduce an auth or data-exposure bug. The worst case is a build error, caught immediately.
- **Immediate web benefit.** A single shared definition of the domain rules means the future RN client can't drift from the web app's validation — the benefit is preventing *future* divergence, not fixing a (non-existent) current one.
- **Keeps O1 open.** Whether web eventually shares the Expo codebase or stays separate, *both* futures want this package. Doing it now commits to nothing except "don't duplicate domain logic."
- **Unblocks topology.** [03-topology](03-topology.md) assumes a place for shared logic to live. This creates it.

## 7. Scope boundary

In scope: relocating the existing pure helpers (`validateScore`, `decimalToNumber`, the pure `sessionCode` exports, `formatScore`, client-safe `displayName`) into `packages/core` **unchanged** + shared wire types. Out of scope: any behaviour change, any new validation rule, any API shape change, anything touching auth or Redis/Postgres/S3 access. If an extraction tempts a behaviour change, stop and split it into a separate change — keep this one a pure, reviewable move so a regression is obvious.
