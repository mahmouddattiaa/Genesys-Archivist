# @genesys-archivist/narrative

## What it does

Evidence-pack builder, resumable narration work queue, and the claim validator that rejects any assertion citing evidence that does not exist.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/security`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
