# npm 12: install-script allowlist and a pinned package manager

**Status:** ROUGH IDEA, not a proposal yet. Recorded 2026-11-07, to be planned **after the Redis rehydration** (`redis-rehydration.md`). It needs more planning and checking before any change; nothing below is a decision.

## Why

- **npm 12 turns dependency install scripts off by default.** A package's `preinstall` / `install` / `postinstall` runs only if it is approved in an `allowScripts` list in `package.json`, and approvals are pinned to exact versions. Install scripts are the classic npm supply-chain attack path, so this is real hardening.
- **The 2026-11-06 dependency review never covered npm itself.** npm ships with Node, and nothing in the repo pins it (no `packageManager` field). The Docker image (`node:24-alpine`) and CI (`setup-node`, Node 24) both run the bundled npm 11; the Deplo.io build on 2026-11-07 used 11.19.1. Node 26 LTS still ships npm 11, so npm 12 only arrives if we install it.
- **npm 11.16 and later already preview it.** Every build prints "4 packages have install scripts not yet covered by allowScripts", and still runs them.

## What we know (2026-11-07)

`npm install-scripts ls` (npm 11.19.1) over the whole workspace, mobile app included, lists four packages:

- `bcrypt@6.0.0` (install: `node-gyp-build`): the native module behind login.
- `@prisma/engines@7.10.1` (postinstall): likely the schema engine `migrate deploy` uses on every deploy.
- `prisma@7.10.1` (preinstall).
- `esbuild@0.28.2` (postinstall): the binary behind `tsx`, which the test suites use.

Bumping any of the four would mean re-approving it, because approvals are version-pinned.

## Still to check before planning

- What each of the four scripts does, and what breaks if it is blocked. The default assumption is to approve all four.
- **Expo tooling under npm 12**: `expo install`, `npx expo export`, the Mac's `npm install` + Xcode build, EAS.
- Whether the repo's own root `postinstall` (patch-package) still runs. npm 12 is reported to block dependency scripts only, not the project's own; unverified.
- Lockfile churn when npm 12 rewrites `package-lock.json`.
- How to pin and install npm 12 in the three places that run npm: the Dockerfile's builder stage, the CI workflows (`setup-node` brings npm 11), and the Mac. A `packageManager` field, or an explicit install step.
- Any `ignore-scripts=true` setting, which is reported to silently override the allowlist. Check every `.npmrc`.
- npm 12's other new defaults (a minimum release age for new versions is reported) and whether they affect Deplo.io builds.

## Likely shape (to be confirmed)

1. **On npm 11 first:** add `allowScripts` for the four packages (`npm install-scripts approve …`, needs npm 11.16+). No behaviour change; the warning goes away.
2. **Then pin npm 12** in Docker, CI and local dev, and verify:
   - a Docker build plus the browser smoke (login exercises `bcrypt`; the deploy job runs `migrate deploy`);
   - a full CI run;
   - an install and a build on the Mac.
3. **Document the re-approval step** for bumps of the four packages, next to the other upgrade notes.

Estimated effort once planned: about half a day, most of it verification.

## Sources

Secondary reporting, to be checked against npm's own documentation during planning:

- [npm 12 Released: Install Scripts off by Default (InfoQ)](https://www.infoq.com/news/2026/08/npm-12-released/)
- [npm 12 Disables Install Scripts by Default (The Hacker News)](https://thehackernews.com/2026/07/npm-12-disables-install-scripts-by.html)
- [npm v12 and install scripts (allowScripts), ApostropheCMS docs](https://apostrophecms.com/docs/guide/npm-v12-install-scripts.html)
- [npm 12 Blocks Install Scripts by Default. Node 26 LTS Still Ships npm 11 (DEV Community)](https://dev.to/posting-dude/npm-12-blocks-install-scripts-by-default-node-26-lts-out-oct-28-still-ships-npm-11-54he)
