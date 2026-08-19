# @genesys-archivist/security

## What it does

Secret resolution, deterministic redaction, path safety, and data classification. The only package permitted to touch a credential store.

## Depends on

- `@genesys-archivist/domain`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
