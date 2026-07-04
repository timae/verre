# ADR 0007 — Blind reveal is direct manipulation on the photo, not a managed mode

**Status:** Accepted · 2026-07-04 · mobile.
**Supersedes:** the two-state reveal UX from the 02b build (resting strip +
"Reveal" entering a manage MODE with per-row pills, Hide all/Reveal all strip
buttons, a sticky Done footer replacing the nav) — Simon's own earlier ruling,
documented in `apps/mobile/CLAUDE.md` §Blind reveal/hide. The server contract
(four reveal endpoints, `revealedAt` semantics, `_blind` redaction) is
untouched; so is the impression detail's reveal bar control.

## Decision (Simon, 2026-07-04)

On a blind session, for hosts/cohosts, **the impression photo IS the reveal
control** — always live, no mode:

- **Hidden** → a translucent glyph covers the whole photo (over-photo
  GLASS_FILL + eye-off). Tapping **arms** it: the overlay flips accent, the
  row's hint line flips to "Tap once more to reveal", and it auto-disarms
  after 2.5s. A second tap while armed fires the reveal. The resting hint
  says **"Double-tap the photo to reveal"** — a quick double tap works (first
  tap arms, second fires), the 2.5s window just also forgives a slow pair.
- **Revealed** → the photo is clear except a small corner **eye badge** cue;
  tapping **anywhere on the photo** hides again instantly (single tap).
- **Masked placeholder** (blind-for-everyone) → the placeholder box is the same
  arm→confirm target.
- Row copy (host, hidden): "Hidden from guests" + the tap hint as a third line.
  Guests' masked rows carry their own context line ("Hidden until the host
  reveals it") — the quiet guest strip died with the host strip.
- **Bulk + scope controls live in the eye menu** on the toolbar line right
  ABOVE the line-up rows — the old strip's spot, below the about block, close
  to the content it acts on (Simon's placement call; it still pins under the
  tabs on scroll): a count header
  ("3 of 8 hidden from guests"), Reveal all, Hide all, and **Blind for all**
  (moved out of the session ⋯ menu — reveal-scope controls live together; the
  ⋯ menu is now identical for blind and non-blind sessions). The future
  line-up search field joins this same row.

## Why the asymmetric arm step

A reveal leaks the identity to every guest within one 5s poll tick and cannot
be truly undone; a hide is the damage-control direction. So the risky
direction costs two deliberate taps on the same spot (an accidental first tap
costs nothing — no server write, a brief self-labelling flash), while the safe
direction stays the fastest tap available, maximising the odds of beating the
next guest poll after a mistaken reveal.

**Why not long-press:** row-hold is reserved for the planned drag-to-reorder
of the line-up; zone-splitting hold gestures between "photo" and "rest of the
row" was rejected as two invisible different holds.

## Consequences

- Deleted: reveal MODE state, the resting/manage strips, the guest strip, the
  per-row Reveal/Hide pills, the sticky Done footer, and the reveal-mode
  tab-bar-hide counter in `lib/sheetVisibility.ts` (sheets remain the only
  in-screen hide reason).
- Both layouts keep their strip machinery, re-purposed: plain = the sticky
  sentinel cell now renders the toolbar; cover-hero = the strip overlay slot
  hosts the toolbar (line-up) or the compare rail (compare), inline below the
  about block, pinning under the tabs on scroll.
- Revealed host rows carry "Tap the photo to hide" in the caption
  slot (grape/type yields to it; the info stays on the impression detail).
- VoiceOver: the photo/badge controls are buttons with state-specific labels
  ("Reveal X — tap twice" / "Tap again to reveal X" / "Hide X from guests").
