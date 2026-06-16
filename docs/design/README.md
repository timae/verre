# Verre design — the spec (mobile app)

Authoritative design source for the **native app** (`apps/mobile`). Authored from
the **shipped, device-verified app + explicit rulings** — NOT from the mockup.
Scope is **mobile only**: the web app is slated for a later redesign and gets no
investment now, so it is not a reference for the app.

This is an **AI-executed, human-led** project (Simon leads; execution is AI). So
these docs are written for the next Claude session first — crisp rules and
decisions it can act on — and for human leads/reviewers second. They are not a
human-narrative design system.

## How design knowledge is split (where to look)

- **What exists / what to reuse** (the component catalog + the "reuse before you
  build, never raw hex" rule + the prioritized extraction backlog) →
  `apps/mobile/CLAUDE.md` § "Component catalog + reuse rule". It lives there
  because that file **auto-loads** when a session touches `apps/mobile/` — a
  catalog only prevents "built three ways" if the builder actually sees it.
- **Why it's decided that way** (rulings + rationale, append-only) → this folder,
  `decisions/` (ADRs).
- **How to build a hard/reusable thing** (the expensive lessons) → `patterns/`.
- **Per-screen detail** → currently the `CLAUDE.md` engineering notes per area
  (`apps/mobile/CLAUDE.md` has a section per shipped surface). A `screens/` layer
  here is deferred until it earns its keep (it's the fastest-drifting part).

## Source-of-truth rule

**The shipped app + the ADRs here win. The Vero handoff in `.local/design/` is a
HISTORICAL reference — a designer's export, gitignored, and provably stale in
places** (it contains an actual sticky-header bug; its bar treatment, blind
framing, and several details were overruled after device testing). Use it only
for the *intent* of screens not yet built; never as the spec for a built screen.
Where it conflicts with a shipped screen or an ADR here, this spec wins.

## Anti-drift discipline (so this doesn't rot like the mockup did)

- State **decisions + rules + rationale** (slow-changing). Defer **exact values**
  to where they're enforced — token names not hex, "use `<StarScore>`" not a
  re-spec of star geometry. Values live in `theme`/`@verre/core`/the components.
- ADRs are **append-only**: overturning a ruling = a NEW ADR that *supersedes*
  the old one. Never silently edit a decision — the history is the point.
- When a `CLAUDE.md` needs a design rationale, **link to the ADR**; don't restate
  it. One decision, recorded once.

## Locked decisions (the durable global ones)

These are settled; don't re-litigate without a superseding ADR.

- **Terminology** (user-facing copy is final): a tasting session is a **"Moment"**;
  a tasted item is an **"Impression"**; saving an impression is **"Crave"**.
  Code identifiers stay `session`/`wine` — only visible copy changed. Full glossary
  in the `verre-vero-handoff-reconciliation` memory + the design codename notes.
  (Not yet an ADR — back-filling terminology as ADR-0001 is a pending task; the
  decision log currently starts at 0003.)
- **App name is "Verre"** ("Vero" was the design codename — appears only in the
  mockup + the `vero-tokens` filename).
- **Roles**: Host · Co-host (full host powers bar 3 strict-host actions) · Taster;
  **Provider** = a functional grant (add + edit/delete only own impressions),
  mutually exclusive with Co-host. On any role/permission conflict with the
  mockup, **the shipped backend model wins** (see the vero-handoff memory + root
  CLAUDE.md tier vocabulary).
- **Tokens, always** — `theme.*` / `radius` / type scale via `useTheme()` /
  `textStyle()` / `VText`; never raw hex (sanctioned exceptions: over-photo glass
  fills + scrim gradients). `theme/vero-tokens.js` is a vendored copy of the
  design tokens — re-vendor, never hand-edit.
- **Native-chrome vs brand-custom** (the O5 split) — every element is one or the
  other; see `apps/mobile/CLAUDE.md` § "Native-chrome vs brand-custom" (the
  canonical statement). Brand-custom = pixel spec (translate the mock class-by-
  class); native-chrome = use the real OS component, tint-only.
- **In-flow footer actions replace the nav** (Previous/Save, Create, Add, Done) —
  a sticky bottom bar, tab bar hidden. Bars over scrolling content are **solid
  opaque** (ADR-0003), not glass.

## Index

Keep one line per file (mirrors root CLAUDE.md's deep-dive index style) so the
next ADR/pattern has an obvious slot and the index stays maintained.

**decisions/** (ADRs — append-only; supersede, never edit):
- `0003-collapsed-bars-opaque.md` — collapsed/in-flow bars are solid opaque, no rule.
- (pending: `0001` terminology · `0002` native-chrome vs brand-custom — settled in prose, not yet ADRs.)

**patterns/** (reusable build recipes — read before building the thing):
- `collapsing-hero-sticky-subheaders.md` — immersive collapsing hero + sticky sub-headers (Dynamic Overlay; the feed hero cards will need this).

**Elsewhere:**
- Component catalog + "reuse before you build" rule + extraction backlog → `apps/mobile/CLAUDE.md` § "Component catalog + reuse rule".
