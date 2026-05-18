# docs/dev/proposals/

Planning docs for work that hasn't shipped yet. Architecture, migration plans, scope debates — anything where the goal is to settle the shape before code lands.

Lifecycle:
- **Active**: lives here while the work is being designed or in-flight.
- **Shipped**: pick whichever serves future readers better — either move to `docs/dev/<name>.md` (rewritten to describe what exists, not what was planned), or keep the file in place as the rationale-of-record and add a status line at the top. Long migration plans with phase-by-phase rationale usually stay put (the rewire is the canonical example); single-feature proposals usually get rewritten. Update the root CLAUDE.md "Feature deep dives" index if the feature deserves one.
- **Abandoned**: delete the file. Git history keeps the trail; a stale "we considered this" doc is worse than no doc.

Files here are not part of the always-loaded context — Claude only reads them when explicitly pointed at one.
