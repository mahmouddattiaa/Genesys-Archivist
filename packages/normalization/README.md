# @genesys-archivist/normalization

## What it does

Converts a raw flow definition into a versioned FlowSnapshot. Infers no business meaning; preserves unsupported constructs rather than dropping them.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/security`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
