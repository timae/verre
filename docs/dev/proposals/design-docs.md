# Proposal: design docs — SHIPPED (mobile-only)

**Status: shipped 2026-06-16.** This proposal asked "how do we document design
guidelines so the next session/teammate gets the full picture and we stop
building the same look three ways." Resolved + built. Scope narrowed to
**mobile only** (the web app is slated for a later redesign — no investment).

## What landed

- **Component catalog + "reuse before you build" rule + a prioritized extraction
  backlog** → `apps/mobile/CLAUDE.md` § "Component catalog + reuse rule". Lives
  there because it **auto-loads** when a session touches `apps/mobile/` — a
  catalog only prevents drift if the builder actually sees it.
- **`docs/design/`** — the decisions + patterns layer (authored from the shipped
  app + rulings, NOT the stale mockup; `.local/design/` demoted to historical
  reference):
  - `README.md` — front door: the split (catalog vs decisions vs patterns), the
    source-of-truth rule, the anti-drift discipline, the locked global decisions.
  - `decisions/` — append-only ADRs. `0003-collapsed-bars-opaque.md` is the first
    in-format ADR. (0001 terminology, 0002 native-chrome split are settled
    elsewhere — back-filling them as formal ADRs is a small pending task.)
  - `patterns/collapsing-hero-sticky-subheaders.md` — the expensive sticky-header
    lesson (Dynamic Overlay recipe + what fails + why), so the feed hero cards
    don't re-walk it.

## Key decisions made along the way (the rationale, for the record)

- **The mockup (`.local/design/`) is NOT the source of truth** — it's a stale,
  gitignored designer export with a real sticky bug and several overruled
  details. The shipped app + ADRs win. Docs are authored from ground truth, not
  by transcribing the mockup.
- **AI-executed, human-led** → docs are written for the next Claude first (crisp
  rules in the auto-loaded `CLAUDE.md` chain), human leads second. Not a
  human-narrative design system, not Storybook (deferred until 2+ people build UI
  daily; the `__DEV__` dev-gallery is the seed).
- **Docs make reuse discoverable; they don't ENFORCE single-implementation —
  shared code does.** So an audit (2026-06-16) found the real "built N ways"
  drift on mobile and recorded it as the extraction backlog in the catalog. Plan:
  **docs now (done), extract the top items next** in a separate reviewed pass
  (highest-leverage: `<AnchoredMenu>`, `<Avatar>`/`<Thumb>`). The audit findings
  ARE the backlog.

## Pending follow-ups (not blockers)

- **Execute the extraction backlog + add ONE enforcement gate** (the
  highest-leverage next step, per the 4-reviewer pass). Docs *record* drift; only
  shared code + a check *stop* it, and a prose "reuse before you build" rule has
  no teeth in an AI-executed repo. So: extract the top items (`<AnchoredMenu>`,
  `<Avatar>`/`<Thumb>`, `<GlassCircleButton>`+`GLASS_FILL`) AND add a ~30-line
  grep-based CI check (mirroring `scripts/check-*.mjs` + a workflow) that FAILS
  the build if the menu-shadow signature / the `rgba(20,18,15,…)` glass literal
  appears OUTSIDE the extracted component. Extraction-without-the-gate just resets
  the clock (the next session re-inlines a 4th copy); the gate is what makes it
  stick. The existing `__DEV__` dev-gallery is thin (~5 primitives) — growing it
  as extractions land turns "what exists" into something browsable, not just
  asserted in prose. (A full `no-color-literals` ESLint rule is NOT worth it —
  raw-hex hygiene is already good; the failure mode is structural component
  duplication, which hex-lint wouldn't catch.)
- Back-fill ADR-0001 (terminology) + ADR-0002 (native-chrome vs brand-custom)
  from the existing prose, so the formal decision log is complete (it starts at
  0003 today, with honest "pending" notes).
- Decide `.local/design/`'s fate (commit / snapshot / leave gitignored) — it's
  the only record of UNBUILT-screen intent and a teammate can't see it. Lean:
  commit or snapshot under a "historical, stale" banner.
- If/when a per-screen `screens/` layer earns its keep, add it under `docs/design/`.
