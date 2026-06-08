# Self-hosted Logto OIDC provider for native clients (mobile-app proposal 01).
# A SECOND Deplo.io app builds from this path (--dockerfile-path="logto/Dockerfile",
# same repo + main) — it is NOT part of Verre's own image. Logto runs the
# prebuilt vendor image unchanged; there is no Verre code here.
#
# Tag is PINNED, never :latest — Logto self-migrates its own schema on upgrade
# (outside Verre's prisma/schema-check guardrails), so version bumps are a
# deliberate, reviewed step: read release notes + snapshot the Economy DB first.
# Bump by editing the tag below. Current stable: 1.40.1 (2026-06).
FROM svhd/logto:1.40.1
