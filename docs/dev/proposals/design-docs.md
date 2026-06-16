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

- ✅ **DONE — top extractions + the enforcement gate.** Extracted `AnchoredMenu`,
  `Avatar`/`Thumb`, and the `GLASS_FILL`/`HERO_SCRIM`/`elevation.menu` constants
  (each its own reviewed commit). Added `scripts/check-mobile-design-tokens.mjs`
  + `.github/workflows/check-mobile-design-tokens.yml` — FAILS the build if the
  glass fill (`rgba(20,18,15,…)`), the hero scrim (`rgba(15,12,10,…)`), or the
  menu shadow (`shadowRadius: 24`) is re-inlined outside its canonical home. This
  is the lever that makes the extractions *stick* (docs alone don't, in an
  AI-executed repo). REMAINING (lower-stakes, when next touching the area): the
  rest of the backlog in `apps/mobile/CLAUDE.md` (`PeopleSheet.Tag→RoleChip`,
  `<CoverPickerField>`, `<TextArea>`, …); growing the `__DEV__` dev-gallery into
  a browsable catalog. (A full `no-color-literals` ESLint rule is NOT worth it —
  raw-hex hygiene is already good; the failure mode was structural duplication,
  which the targeted gate above catches.)
- Back-fill ADR-0001 (terminology) + ADR-0002 (native-chrome vs brand-custom)
  from the existing prose, so the formal decision log is complete (it starts at
  0003 today, with honest "pending" notes).
- Decide `.local/design/`'s fate (commit / snapshot / leave gitignored) — it's
  the only record of UNBUILT-screen intent and a teammate can't see it. Lean:
  commit or snapshot under a "historical, stale" banner.
- If/when a per-screen `screens/` layer earns its keep, add it under `docs/design/`.
