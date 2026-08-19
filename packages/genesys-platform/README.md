# @genesys-archivist/genesys-platform

## What it does

Genesys Cloud Platform API adapter: authentication, flow discovery, resource fetching, asset download, pagination, retry classification. No SDK object crosses its boundary.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/security`
- `@genesys-archivist/observability`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
