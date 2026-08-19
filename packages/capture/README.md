# @genesys-archivist/capture

## What it does

STAGE 1. Resource reference-graph walker, SHA-256 asset deduplication, bundle writer and sealer. Produces the immutable capture bundle.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/genesys-platform`
- `@genesys-archivist/genesys-source`
- `@genesys-archivist/storage`
- `@genesys-archivist/security`
- `@genesys-archivist/observability`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
