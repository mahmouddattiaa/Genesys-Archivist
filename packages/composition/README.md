# @genesys-archivist/composition

## What it does

The composition root. The one place concrete adapters are wired to the interfaces application declares. Keeps apps/* genuinely thin.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/application`
- `@genesys-archivist/security`
- `@genesys-archivist/observability`
- `@genesys-archivist/storage`
- `@genesys-archivist/genesys-platform`
- `@genesys-archivist/genesys-source`
- `@genesys-archivist/capture`
- `@genesys-archivist/normalization`
- `@genesys-archivist/analysis`
- `@genesys-archivist/documentation`
- `@genesys-archivist/rendering`
- `@genesys-archivist/narrative`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
