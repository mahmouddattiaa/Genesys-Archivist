# @genesys-archivist/genesys-source

## What it does

Flow-definition source providers behind one GenesysSourceProvider interface: Platform API, Archy CLI, Architect Scripting SDK, and manual YAML. Read-only by construction.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/security`
- `@genesys-archivist/observability`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
