# Proposal: multi-agent project guidance

**Status: proposed 2026-07-05; reworked after review; Phase 0 validated
2026-07-05.** This proposal captures how Verre should make its agent guidance
reliable for Claude, Codex, Gemini, and future coding agents. The goal is not
"what works for today's editor"; it is: when an arbitrary agent walks in cold,
does it reliably get the right context?

**Phase 0 result (2026-07-05).** The four tool-behavior claims below were
verified against the actually-installed tools — Codex `0.142.5`, Gemini CLI
`0.49.0`, Claude Code (this repo's harness) — by reading each tool's source at
that version *and*, for Codex, running the live binary (`codex debug
prompt-input` renders the exact model-visible prompt). All four hold. Two
corrections came out of it and are folded in below:

1. **Codex truncates project docs at a default 32 KiB** (`project_doc_max_bytes`
   / `AGENTS_MD_MAX_BYTES`, `codex-rs/core/src/agents_md.rs`). A generated root
   `AGENTS.md` that inlined the expanded rate-limit policy would measure ~36 KiB
   and be **silently truncated ~3 KiB from the end** — landing on the "where to
   find detail" pointer index, the exact routing a cold Codex agent needs.
   Resolved: the generator emits the rate-limit policy as a **pointer** under a
   30 KiB budget, so the artifact never truncates (see Decision → "Resolved — the
   32 KiB fork" and Risks).
2. **Gemini's `@file` placement rule is word-boundary + not-in-code-span, not
   "line-isolated"** (`packages/core/src/utils/memoryImportProcessor.ts`). The
   Phase 0 list is corrected accordingly.

## Problem

Verre's AI-facing docs are strong, but the discovery mechanism is Claude-shaped.
The repo has a root `CLAUDE.md` plus scoped `CLAUDE.md` files under `app/`,
`app/api/`, `app/api/auth/`, `components/`, `components/wine/`, `lib/`,
`prisma/`, `apps/mobile/`, and
`apps/mobile/src/theme/flavour-palette/`.

That gives Claude Code good automatic context. It does not give the same
guarantee to other agents:

| Agent | Scoped-file discovery | `@file` expansion |
|---|---|---|
| Claude Code | touch/subtree-oriented memory loading | yes |
| Gemini CLI | context-file discovery plus `GEMINI.md`; configurable names | yes, with tool-specific rules |
| Codex | git-root-to-current-working-directory walk | no; `@file` is literal text |

Codex additionally caps loaded project docs at a default 32 KiB
(`project_doc_max_bytes`) and silently truncates the overflow — a hard
constraint on how large a generated root `AGENTS.md` can be. See the Decision and
Risks sections.

The broken assumption in the first draft was that per-directory `AGENTS.md`
adapters plus `@AGENTS.md` imports could be the portable primitive. They cannot.
Codex is the decisive counterexample: when launched at repo root, it does not
load `app/api/AGENTS.md` merely because it later edits `app/api/**`, and it does
not expand `@app/api/rate-limits.md` or `@AGENTS.md`.

So the portable primitive is not scoped auto-load. The portable primitive is the
root file plus explicit read instructions.

## Goal

Make root-loaded guidance sufficient for a cold agent to route itself to the
right context, while keeping exactly one editable source of truth for project
guidance.

Target behavior:

- Every agent reliably receives a root guide.
- The root guide contains the cross-cutting invariants that must not be missed.
- The root guide contains an explicit routing map: if editing X, read Y.
- Scoped guides remain the detailed pointer targets.
- Claude and Gemini may still auto-load scoped files as a bonus, but correctness
  does not depend on that.
- Codex can work from a repo-root launch without hidden per-directory context.
- Generated compatibility files are mechanically checked so drift is impossible
  or immediately CI-visible.

## Non-goals

- Do not fan out 30 adapter files as the core mechanism.
- Do not move the mobile component catalog out of `apps/mobile/CLAUDE.md` in
  this proposal. That would reverse the shipped design-docs decision and needs a
  separate proposal if we want it.
- Do not require local Gemini/Codex configuration for the repo to be usable.
- Do not rewrite feature deep-dives into instruction files.
- Do not update every code comment that currently points at `CLAUDE.md`; keeping
  those paths valid is part of the migration strategy.

## Decision

Keep **`CLAUDE.md` as the initial editable source of truth** for project
guidance, because the repo and code comments already point at it heavily. Add
root-level generated compatibility files:

- `AGENTS.md` for Codex and the broader agent convention.
- `GEMINI.md` for Gemini surfaces that read it by default.

The root generated files are not hand-edited. A small script should derive them
from the canonical root source and CI should fail if committed generated files
are stale.

Important: generated root files must not contain Claude-only `@file` imports that
Codex cannot expand. Keep `@app/api/rate-limits.md` in canonical `CLAUDE.md` so
the human-facing root file stays under its 250-line soft cap and
`app/api/rate-limits.md` remains the single rate-limit source. The generator
resolves root-level `@file` imports for generated `AGENTS.md` and `GEMINI.md` —
inlining the content as concrete text **when it fits the byte budget**, otherwise
emitting a pointer to the source file. See the resolved 32 KiB fork below for the
budget rule and why the rate-limit policy is pointer-first in this repo today.

**Confirmed against live Codex 0.142.5 (2026-07-05).** A real Codex session in
this repo was asked for the account PATCH+DELETE rate limit. It answered
correctly — but *not* because of the `@app/api/rate-limits.md` line, which it
confirmed it treated as plain text: "the `@...` line itself did not cause special
behavior." It reached the right answer only because its own `rg` search surfaced
`app/api/rate-limits.md` (well-named, endpoint in the table) and it opened the
file directly. So expansion is load-bearing, not belt-and-suspenders: content
that lives *only* behind an `@import` and is not independently grep-discoverable
on a natural task query is invisible to Codex. That is precisely the danger for
cross-cutting invariants (trust model, Decimal wire-format, cascade-vs-tombstone)
— an agent adding an endpoint does not grep for them, so they must be pushed into
the loaded context as real text, not left behind a dead pointer.

**Resolved — the 32 KiB fork (decided 2026-07-05).** Expanding
`@app/api/rate-limits.md` inline is what pushes the generated `AGENTS.md` over
Codex's 32 KiB cap (root `CLAUDE.md` ~26.4 KiB + `rate-limits.md` ~9.6 KiB ≈
36 KiB, over by ~3.2 KiB). The cap is not committable (`project_doc_max_bytes` is
per-user config), so the artifact itself must fit. Decided design:

- **Budget rule.** The generator may inline an imported file's content **only when
  the final artifact stays under a 30 KiB budget** (headroom below the 32 KiB cap
  for `CLAUDE.md` growth). It builds the full candidate, measures bytes, and emits
  either inline policy or a pointer accordingly — a deterministic
  measure-then-emit, not a try-and-recover.
- **Current behavior (this repo, today).** The full inline output exceeds
  30 KiB, so the generated root `AGENTS.md` emits the rate-limit policy as a
  **pointer** to `app/api/rate-limits.md` from commit 1. Pointer-first is the
  standing outcome here, not a rare fallback — do not describe rate limits as
  "usually inline." The rate-limit policy is the correct thing to degrade because,
  per the live-Codex test, it is the one piece Codex reliably grep-discovers
  (well-named file, endpoint names in the table) — it found it with no pointer at
  all. Cross-cutting invariants stay inline as text; they are *not* candidates for
  degradation, because an agent adding an endpoint does not grep for them.
- **Ordering (defense in depth).** The generator emits cross-cutting invariants
  and the routing map **before** any bulky/degradable content, so that even if the
  budget were ever misconfigured or a maintainer raised it, a truncation sheds the
  least-critical tail rather than the map. This is the belt, not the trousers — the
  budget rule is what guarantees correctness; ordering is the backstop.
- **CI role.** CI **enforces** — it asserts the emitted artifact is under budget
  and that the routing map precedes bulky sections. CI does **not** mutate
  generated output; the generator owns the full-vs-pointer decision, CI only
  gates. (Keeps the "generator-clean CI" property: same input → same output →
  no diff.)
- **General vs repo-specific generator (open, Phase 1 implementation call).**
  Bias: keep the generic measure-then-emit machinery if it is small and easy to
  test, so a future *small* import (a few hundred bytes) can inline while the
  rate-limit policy stays a pointer. If that machinery adds real complexity, just
  always pointer-ize the current rate-limit import and revisit general import
  budgeting when a second import actually appears. Either way the current output is
  identical (rate-limits as a pointer); this choice only affects generator
  internals.

Do **not** create per-directory `AGENTS.md`/`GEMINI.md` adapters as the first
migration. Scoped `CLAUDE.md` files stay in place and stay valid. Root
`AGENTS.md`/`GEMINI.md` route agents to those scoped files explicitly.

## Alternatives considered

### Codex `CLAUDE.md`-fallback via committed `.codex/config.toml`

Instead of generating an `AGENTS.md`, point Codex at the existing modular
`CLAUDE.md` files by setting `project_doc_fallback_filenames = ["CLAUDE.md"]` in a
repo-committed `.codex/config.toml`. Tested empirically against Codex `0.142.5`
(`codex debug prompt-input` for what loads; a live session for behavior).

What it buys:

- Codex **reads root `CLAUDE.md`** with no generated file and no drift gate.
- Scoped `CLAUDE.md` loads on the same root→cwd walk — from a cwd under
  `app/api/`, both root and `app/api/CLAUDE.md` load. (Same walk as native
  AGENTS.md; the fallback name just rides it.)
- The config is **committable**: Codex has a project config layer
  (`$(git rev-parse --show-toplevel)/.codex/config.toml`, precedence 25), and
  `project_doc_fallback_filenames` is not on the project-local denylist.

Why it does **not** replace the generated root file:

1. **Trust gate.** The project-local config is "loaded but disabled when the
   directory is untrusted." Verified: untrusted → the committed config is
   ignored; trusted → it drives the fallback. A cold agent on a fresh clone gets
   nothing until the first-run workspace-trust prompt is accepted. Not
   zero-config.
2. **Dead `@import`.** Codex reads `CLAUDE.md` verbatim, so
   `@app/api/rate-limits.md` lands as a literal dead line — the rate-limit policy
   is absent from context. The live session confirmed Codex does not dereference
   the `@` line; it only found the file via grep (see the Decision note). You
   cannot pre-expand here the way the generator can, so cross-cutting content that
   is not independently grep-discoverable stays invisible.
3. **No root-launch scoped loading.** Same cwd limitation as AGENTS.md — at repo
   root, `app/api/CLAUDE.md` never loads regardless of edit target. The proposal
   already refuses to rely on scoped auto-load for correctness, so this is not a
   regression, but the fallback does not fix it either.

Verdict: a **complement, not a replacement**. It could let Codex pick up the same
modular `CLAUDE.md` files Claude uses (nice for the scoped-when-cwd-matches case,
zero new files to maintain) and cleanly avoids the generate-and-drift-check cost
and the 32 KiB truncation problem (each modular file is small). But it ships Codex
*without* the cross-cutting invariants unless those are also inlined into
`CLAUDE.md` — which reintroduces the 250-line-cap tension the generated-file plan
exists to avoid. So the root routing map + inlined invariants still carry
correctness for the root-launch case; the fallback is at most an add-on. If
adopted as an add-on, add `.codex/config.toml` to the repo and note the trust-gate
in onboarding docs.

## Source-of-truth rules

After the first migration:

- Root `CLAUDE.md` is canonical.
- Root `AGENTS.md` and `GEMINI.md` are generated from root `CLAUDE.md`, with
  root-level `@file` imports resolved under the byte-budget rule (inline if it
  fits, else a pointer — pointer-first for the rate-limit policy today).
- Scoped `CLAUDE.md` files remain canonical for their subtrees.
- Root `AGENTS.md`/`GEMINI.md` must list scoped `CLAUDE.md` files as read
  targets; they do not rely on scoped auto-load.
- Feature deep-dives stay in `docs/dev/`.
- Mobile design decisions stay in `docs/design/` ADRs and patterns.
- `docs/dev/proposals/` remains for unshipped or rationale-of-record work.

Future cleanup can revisit whether scoped files should be renamed to
`AGENTS.md`, but that should be a separate change after the root-map mechanism is
proven.

## Root Routing Map

The root guide must explicitly say: "Before editing a path, read the relevant
scoped guide and feature docs below." This is the safety mechanism for agents
that only load root.

| Area touched | Required explicit reads |
|---|---|
| `app/**` | `app/CLAUDE.md` |
| `app/api/**` | `app/api/CLAUDE.md`, `lib/CLAUDE.md`, relevant `docs/dev/<feature>.md` |
| `app/api/auth/**` | `app/api/CLAUDE.md`, `app/api/auth/CLAUDE.md`, `lib/CLAUDE.md`, `docs/dev/proposals/auth-sessions.md`, `docs/dev/proposals/mobile-app/01-identity-and-auth.md` when auth/session behavior is involved |
| `lib/**` | `lib/CLAUDE.md`; add `app/api/CLAUDE.md` and auth docs for identity, Redis, session, rate-limit, visibility, or credential work |
| `prisma/**` | `prisma/CLAUDE.md`; destructive migrations require explicit human confirmation |
| `components/**` | `components/CLAUDE.md` |
| `components/wine/**` | `components/CLAUDE.md`, `components/wine/CLAUDE.md`, `docs/dev/ios-touch-gestures.md` |
| `apps/mobile/**` | `apps/mobile/CLAUDE.md`, `docs/design/README.md`, relevant ADRs/patterns, relevant `docs/dev/proposals/mobile-app/*.md` |
| `apps/mobile/src/theme/flavour-palette/**` | `apps/mobile/CLAUDE.md`, `apps/mobile/src/theme/flavour-palette/CLAUDE.md` |
| `packages/core/**` | root `packages/core` guidance, `docs/dev/proposals/mobile-app/00-shared-logic-extraction.md`, and affected web/native callers |

`packages/core` is an intentional exception today: no scoped guide exists. The
root row must be concrete enough to route work until a real `packages/core`
guide earns its keep.

## Cross-Cutting Root Content

Root must directly carry the invariants a cold agent cannot be trusted to
discover by following links. These invariants are **always inline text** in the
generated files — they are never degraded to a pointer, because an agent doing
unrelated work does not grep for them. (This is distinct from the rate-limit
policy, which arrives via the `@app/api/rate-limits.md` import and *is* subject to
the byte-budget degradation — it is safe to pointer-ize precisely because it is
grep-discoverable; see the resolved 32 KiB fork.) The always-inline invariants:

- trust model: identity ids only; display names and URL params are
  presentation-only,
- score validation and Prisma Decimal wire-format coercion,
- credential/revocation chokepoint in `lib/identityStore.ts`,
- Better Auth Redis-first revocation rule,
- authorization tier vocabulary,
- cascade-vs-tombstone policy,
- profile-visibility gate,
- freemium/pro gates that affect API design,
- session soft-delete invariant,
- rate-limit endpoint *patterns* (shared-counter pairs, recovery paths uncapped,
  peek-then-check) — the design rules, inline; the full per-endpoint policy
  *table* is the degradable `@import` (pointer-first today), not this bullet,
- branch/review/schema workflow.

Long implementation details can stay behind pointers, but these rules should be
root-visible for every agent.

## Migration Phases

### Phase 0 - prove mechanics first

Use a throwaway branch before committing the proposal's final implementation
shape.

**Done 2026-07-05** against Codex `0.142.5`, Gemini CLI `0.49.0`, Claude Code
(this harness) — source read at each version plus, for Codex, the live binary
(`codex debug prompt-input`). Results:

- ✅ Codex launched at repo root loads root `AGENTS.md`, but **not** scoped guides
  based on edited files — its discovery is a git-root→cwd walk keyed on the
  working directory, never on edit targets. Proved live: from root only root
  `AGENTS.md` loads; from `app/api/` both root and the nested file load.
- ✅ Codex treats `@file` as literal text — the line is emitted verbatim, the
  target is not inlined. No `@`-expansion exists in the loader.
- ✅ Claude Code reads root `CLAUDE.md`, expands its `@app/api/rate-limits.md`
  import, and lazy-loads the current scoped `CLAUDE.md` files on subtree touch
  (observed live in this session). All nine tracked scoped `CLAUDE.md` files in
  the routing map exist; `packages/core` has none, as noted.
- ✅ Gemini reads `GEMINI.md` by default (`DEFAULT_CONTEXT_FILENAME`),
  configurable via `context.fileName` (string or array).
- ⚠️ **NEW**: Codex silently truncates project docs past a default 32 KiB
  (`project_doc_max_bytes`). The inline-expanded root `AGENTS.md` measures ~36 KiB
  today and would lose its tail routing map. Resolve the 32 KiB fork (see
  Decision) before Phase 1 — do not just "expand and check the diff."
- **Corrected**: if any generated file keeps an `@file` reference for Gemini, the
  real expansion rule is **left word-boundary + not inside a backtick code span**
  (inline or fenced), *not* "line-isolated." An import preceded by a space
  expands even mid-line; an import inside `` `...` `` or a ``` fence stays
  literal. Recursive to depth 5, circular-safe, `context.importFormat` = `tree`
  (default) or `flat`. Still prefer no `@file` references in generated files — but
  don't document the line-isolation rule, it's wrong.

Do not lock a per-tool file strategy before this check. Phase 0 confirmed the
core claims and surfaced the 32 KiB constraint; that constraint is now resolved
(see the Decision's "Resolved — the 32 KiB fork") and its byte-budget rule feeds
directly into the Phase 1 generator.

### Phase 1 - root compatibility files

One focused implementation:

1. Keep root `CLAUDE.md` canonical.
2. Add generated root `AGENTS.md`.
3. Add generated root `GEMINI.md`.
4. Keep `@app/api/rate-limits.md` in canonical `CLAUDE.md`; in generated root
   files, **emit it as a pointer to `app/api/rate-limits.md`** — the full inline
   output exceeds the 30 KiB budget, so pointer is the current output, not a
   fallback. (The generic budget rule that would inline a smaller future import is
   in the resolved 32 KiB fork; it does not change this import's output today.)
5. Add a script that regenerates the generated root files (deterministic
   measure-then-emit) and a CI check that enforces the byte budget + routing-map
   ordering without mutating output.
6. Add CI for generator-cleanliness: running the generator on a clean checkout
   must produce no diff.

**Preserve the resolved invariants as tests, not just prose.** The distinction
above regresses silently once it becomes code unless it is pinned by assertions.
Phase 1 must ship tests for:

- generated root `AGENTS.md` is under `30 * 1024` bytes;
- the routing map appears **before** the rate-limit pointer or any
  bulky/degradable section;
- the current rate-limit policy emits as a **pointer**, not inline text;
- (only if the generic measure-then-emit path is chosen) a small synthetic import
  still inlines — so the generic capability is exercised and doesn't rot into
  dead code.

This phase should not touch scoped `CLAUDE.md` files except if root wording needs
to point at them more explicitly.

### Phase 2 - root map and wording cleanup

Update root guidance to make explicit reads non-optional:

- add the routing map,
- keep the 250-line root soft cap on canonical `CLAUDE.md` or replace it with a
  measured check that still protects against root bloat,
- rewrite "Claude lazy-loads" phrasing in root to "some agents may auto-load;
  all agents must follow the routing map",
- rewrite the reviewer rule in tool-neutral terms.
- make canonical root wording tool-neutral; the filename may remain
  `CLAUDE.md`, but its content should be suitable to generate into
  `AGENTS.md` and `GEMINI.md` without a tool-specific substitution pass.

When doing wording cleanup, use a grep-based audit, not a fixed four-string
replace. Search for at least:

```bash
rg -n "CLAUDE\\.md|Claude|claude|lazy-load|auto-load|subagent|Subagent" \
  CLAUDE.md docs app components lib prisma apps packages scripts
```

Do not churn code comments that intentionally point at valid `CLAUDE.md` files.
The purpose is to remove wrong canonical-file claims, not to rename every
reference.

### Phase 3 - completeness checks

Add a lightweight script once the root map exists:

- generated root `AGENTS.md` and `GEMINI.md` are clean,
- root routing map lists every tracked scoped `CLAUDE.md`,
- root routing map has an intentional exception for directories without scoped
  guides, such as `packages/core`,
- root generated files do not contain literal unexpanded `@app/...` imports,
- canonical root source stays under the chosen size/bloat threshold,
- generated root `AGENTS.md` stays under a safe byte budget below Codex's 32 KiB
  `project_doc_max_bytes` cap (e.g. 30 KiB), so it is never silently truncated.

This is a real drift check. Do not merely check that sibling files exist.

### Deferred - scoped renaming or mobile split

Renaming scoped files to `AGENTS.md`, adding per-directory adapters, or splitting
`apps/mobile/CLAUDE.md` are explicitly deferred.

Reasons:

- Codex does not get correctness from scoped adapters when launched at root.
- The repo already has many code comments pointing at scoped `CLAUDE.md` files.
- The mobile catalog's location is a shipped decision: it lives in
  `apps/mobile/CLAUDE.md` because being seen before mobile UI work matters.
- The mobile file is large, but size is a separate design-docs question, not a
  blocker for root multi-agent compatibility.

If mobile size becomes the next problem, write a separate proposal that engages
the shipped design-docs rationale directly.

## Reviewer Rule After Migration

Replace the Claude-specific reviewer wording with a tool-neutral rule:

- Get a second-agent review before pushing when a diff touches auth/schema, spans
  more than 3 files or 50 lines, or introduces a shared primitive.
- The reviewer brief must explicitly list the scoped guides and feature docs to
  read.
- For auth/security/schema: include `app/api/CLAUDE.md`, `lib/CLAUDE.md`, and
  relevant `docs/dev/` files.
- For mobile/UI: include `apps/mobile/CLAUDE.md`, `docs/design/README.md`, and
  relevant ADRs/patterns.

This keeps the existing safety practice but removes the assumption that the
reviewer automatically sees scoped context.

## Acceptance Criteria

The migration is done when:

- Codex launched at repo root receives a useful `AGENTS.md` with no dead
  `@file` imports **and under Codex's 32 KiB `project_doc_max_bytes` cap**, so the
  routing map is never truncated. The generator asserts the byte budget in CI.
- Claude launched at repo root still receives the canonical guidance through
  `CLAUDE.md`.
- Gemini launched at repo root receives equivalent guidance through `GEMINI.md`.
- Generated root files are mechanically checked and cannot drift silently.
- A new API task is routed to API, auth, lib, and relevant feature docs from the
  root map alone.
- A new mobile UI task is routed to mobile guide + design docs from the root map
  alone.
- Scoped `CLAUDE.md` paths referenced from code comments remain valid.
- No correctness depends on an agent auto-loading a scoped file.

## Risks

- **Generated file drift.** Mitigation: generator-clean CI, not convention.
- **Codex 32 KiB truncation (Phase 0 finding).** Codex silently drops project-doc
  bytes past `project_doc_max_bytes` (default 32 KiB). A naive inline-expanded root
  `AGENTS.md` is ~36 KiB and would lose its tail. This is the sharpest tension
  with "Root bloat": expanding imports makes the generated file *larger*, which is
  precisely what the cap punishes. Mitigation (resolved, see Decision): the
  generator inlines an import only when the artifact stays under a 30 KiB budget,
  else emits a pointer — so the emitted file never exceeds the cap; CI enforces the
  budget rather than the generator relying on the cap. Cross-cutting invariants and
  the routing map are emitted first as defense in depth. Do not rely on users
  raising the cap — it is per-user config, not committable.
- **Root bloat.** Mitigation: preserve a soft cap or measured size check and
  keep implementation detail in scoped docs. Note this now cuts both ways —
  generator-expanded files can be larger than canonical root, but must still land
  under Codex's byte cap, so "expanded can be larger" is bounded, not free.
- **Pointer fatigue.** The root map only works if agents follow it. Mitigation:
  make explicit reads a root instruction and reviewer requirement, and keep the
  map short enough to scan.
- **Tool behavior changes.** Mitigation: Phase 0 validated the actual installed
  tools (Codex `0.142.5`, Gemini `0.49.0`, Claude Code) on 2026-07-05; re-run the
  checks if the pinned tool versions move materially, since discovery/cap
  behavior is version-specific.
- **Rate-limit import regression.** Mitigation: keep `app/api/rate-limits.md` as
  the single source; the generator resolves the root import to inline text or a
  pointer per the budget rule (pointer-first today); CI rejects literal unresolved
  `@app/...` imports in generated files.

## Open Questions

- Should the generated root `GEMINI.md` be enough, or do we also need singular
  root `AGENT.md` for Gemini Code Assist IntelliJ compatibility? Out of scope
  for commit 1 unless Phase 0 proves it is needed.
- Resolved for commit 1: root `CLAUDE.md` stays canonical. A neutral internal
  source file can be reconsidered only if the generator grows complex enough to
  justify it.
- Should `packages/core/CLAUDE.md` be added now, or is the root routing row
  enough until shared-core work grows?

## Proposed First Implementation Commit

One focused commit:

1. Add root `AGENTS.md` and root `GEMINI.md` generated from root `CLAUDE.md`.
2. Add a generator/check script and CI gate.
3. Resolve the root rate-limit import in generated files under the byte-budget
   rule — a pointer to `app/api/rate-limits.md` today (full inline exceeds the
   30 KiB budget), while `app/api/rate-limits.md` remains the single source. Codex
   reliably grep-discovers that file, so the pointer is sufficient.
4. Add the root routing map.
5. Update the reviewer rule to require explicit scoped-doc reads.

No scoped file renames. No mobile split. No per-directory adapter fan-out.
