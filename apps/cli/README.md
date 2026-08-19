# @genesys-archivist/cli

## What it does

The `archivist` CLI. Secure profile provisioning, diagnostics, capture, documentation, and headless sync. Owns everything that must never be an MCP tool argument.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/application`
- `@genesys-archivist/composition`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
