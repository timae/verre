# docs/dev/proposals/

Planning docs for work that hasn't shipped yet. Architecture, migration plans, scope debates — anything where the goal is to settle the shape before code lands.

Lifecycle:
- **Active**: lives here while the work is being designed or in-flight.
- **Shipped**: move to `docs/dev/<name>.md` (often rewritten to describe what exists, not what was planned). Update the root CLAUDE.md "Feature deep dives" index if the feature deserves one.
- **Abandoned**: delete the file. Git history keeps the trail; a stale "we considered this" doc is worse than no doc.

Files here are not part of the always-loaded context — Claude only reads them when explicitly pointed at one.
