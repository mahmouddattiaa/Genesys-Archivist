# @genesys-archivist/mcp-server

## What it does

The `genesys-archivist` MCP STDIO server. Validates tool input, invokes use cases, exposes resources. Contains no Genesys logic and no secrets.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/application`
- `@genesys-archivist/composition`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
