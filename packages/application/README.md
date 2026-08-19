# @genesys-archivist/application

## What it does

Use cases, run state machines, and policy enforcement. Depends on interfaces only; adapters are injected. Imports domain and nothing else.

## Depends on

- `@genesys-archivist/domain`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
