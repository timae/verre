# Agent guidance

This repo's guidance lives in `CLAUDE.md` files, and they are authoritative. Read them before changing anything:

- **`CLAUDE.md`** (repo root): cross-cutting invariants, branching and review rules, where new content goes. It pulls in `app/api/rate-limits.md` with an `@` import, so read that file too.
- **The nearest `CLAUDE.md` in every directory you touch** (for example `lib/`, `app/api/`, `prisma/`, `apps/mobile/`). The root file lists them under "Area CLAUDE.md".

Nothing else belongs in this file. The block below is written and kept up to date by `next dev`; edit outside its markers only.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
