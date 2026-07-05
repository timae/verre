# Proposal: multi-agent project guidance

**Status: proposed 2026-07-05; reworked after review.** This proposal captures
how Verre should make its agent guidance reliable for Claude, Codex, Gemini, and
future coding agents. The goal is not "what works for today's editor"; it is:
when an arbitrary agent walks in cold, does it reliably get the right context?

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
must expand root-level `@file` imports into concrete text for generated
`AGENTS.md` and `GEMINI.md`.

Do **not** create per-directory `AGENTS.md`/`GEMINI.md` adapters as the first
migration. Scoped `CLAUDE.md` files stay in place and stay valid. Root
`AGENTS.md`/`GEMINI.md` route agents to those scoped files explicitly.

## Source-of-truth rules

After the first migration:

- Root `CLAUDE.md` is canonical.
- Root `AGENTS.md` and `GEMINI.md` are generated from root `CLAUDE.md`, with
  root-level `@file` imports expanded.
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
discover by following links. In canonical `CLAUDE.md`, direct carry can include
Claude-expanded root imports such as `@app/api/rate-limits.md`; in generated
files, those imports must be expanded into real text:

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
- production rate-limit policy and endpoint patterns,
- branch/review/schema workflow.

Long implementation details can stay behind pointers, but these rules should be
root-visible for every agent.

## Migration Phases

### Phase 0 - prove mechanics first

Use a throwaway branch before committing the proposal's final implementation
shape.

Verify:

- Codex launched at repo root loads root `AGENTS.md`, but not scoped guides based
  on edited files.
- Codex treats `@file` as literal text.
- Claude Code reads root `CLAUDE.md` and still handles the current scoped
  `CLAUDE.md` layout.
- Gemini reads root `GEMINI.md`.
- Generated `AGENTS.md` and `GEMINI.md` contain the rate-limit policy as actual
  text, not an `@app/...` import.
- If any generated file intentionally keeps an `@file` reference, verify Gemini's
  placement rule: the reference must be line-isolated and in a form Gemini
  expands. Prefer no `@file` references in generated files.

Do not lock a per-tool file strategy before this check. The decision above is
based on current reviewed behavior; Phase 0 is the practical guard against stale
tool docs.

### Phase 1 - root compatibility files

One focused implementation:

1. Keep root `CLAUDE.md` canonical.
2. Add generated root `AGENTS.md`.
3. Add generated root `GEMINI.md`.
4. Keep `@app/api/rate-limits.md` in canonical `CLAUDE.md`, but expand it in
   generated root files.
5. Add a script that regenerates/checks the generated root files.
6. Add CI for generator-cleanliness: running the generator on a clean checkout
   must produce no diff.

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
- canonical root source stays under the chosen size/bloat threshold.

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
  `@file` imports.
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
- **Root bloat.** Mitigation: preserve a soft cap or measured size check and
  keep implementation detail in scoped docs. Generator-expanded files can be
  larger than canonical root because they contain expanded imports.
- **Pointer fatigue.** The root map only works if agents follow it. Mitigation:
  make explicit reads a root instruction and reviewer requirement, and keep the
  map short enough to scan.
- **Tool behavior changes.** Mitigation: Phase 0 validates the actual installed
  tools before implementation.
- **Rate-limit import regression.** Mitigation: keep `app/api/rate-limits.md` as
  the single source and expand root imports for generated files; CI rejects
  literal root `@app/...` imports in generated files.

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
3. Expand the root rate-limit import in generated files so Codex receives real
   policy text while `app/api/rate-limits.md` remains the single source.
4. Add the root routing map.
5. Update the reviewer rule to require explicit scoped-doc reads.

No scoped file renames. No mobile split. No per-directory adapter fan-out.
